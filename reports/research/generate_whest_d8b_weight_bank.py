"""Regenerate the first D8b corpus weights exactly from the public seed recipe."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import torch


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=128)
    parser.add_argument("--seed0", type=int, default=770000)
    parser.add_argument("--index-stride", type=int, default=1,
                        help="step between corpus IDs; use the target shard's actual idx spacing")
    parser.add_argument("--index-offset", type=int, default=0,
                        help="first corpus idx represented by the bank")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    if args.count < 1 or args.index_stride < 1 or args.index_offset < 0:
        raise ValueError("count/stride must be positive and offset non-negative")
    if args.output.exists() or args.manifest.exists():
        raise FileExistsError("refusing to overwrite an existing weight bank or manifest")

    torch.set_num_threads(min(8, torch.get_num_threads()))
    shape = (args.count, 16, 1024, 1024)
    bank = np.lib.format.open_memmap(args.output, mode="w+", dtype=np.float32, shape=shape)
    hashes: list[str] = []
    for idx in range(args.count):
        corpus_idx = args.index_offset + args.index_stride * idx
        seed = args.seed0 + corpus_idx
        generator = torch.Generator(device="cpu").manual_seed(seed)
        weights = torch.randn((16, 1024, 1024), generator=generator, dtype=torch.float32)
        weights.mul_((2.0 / 1024) ** 0.5)
        array = weights.numpy()
        bank[idx] = array
        hashes.append(hashlib.sha256(memoryview(np.ascontiguousarray(array)).cast("B")).hexdigest())
        if (idx + 1) % 16 == 0 or idx + 1 == args.count:
            bank.flush()
            print(f"generated {idx + 1}/{args.count}", flush=True)

    bank.flush()
    manifest = {
        "source": "keenanpepper/arc-whestbench-p2-d8b-corpus-14k",
        "source_card": "https://huggingface.co/datasets/keenanpepper/arc-whestbench-p2-d8b-corpus-14k",
        "seed_recipe": "torch.Generator(device='cpu').manual_seed(seed0 + corpus_idx)",
        "weight_recipe": "torch.randn((16,1024,1024), dtype=float32) * sqrt(2/1024)",
        "seed0": args.seed0,
        "count": args.count,
        "index_stride": args.index_stride,
        "index_offset": args.index_offset,
        "corpus_indices": [args.index_offset + args.index_stride * i for i in range(args.count)],
        "shape": shape,
        "dtype": "float32",
        "weight_sha256": hashes,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"manifest={args.manifest}")


if __name__ == "__main__":
    main()
