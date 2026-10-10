#!/usr/bin/env python3
"""Build a hash-verified weight/target bank from the public D8b corpus shards."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import torch


def sha256(data: bytes | memoryview) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-prefix", type=Path, required=True)
    parser.add_argument("--count", type=int, default=64)
    parser.add_argument("--seed", type=int, default=20261012)
    parser.add_argument("--weight-seed0", type=int, default=770000)
    args = parser.parse_args()
    if args.count < 16:
        raise SystemExit("count must be >=16 for grouped network validation")

    rows: list[tuple[int, np.ndarray, str]] = []
    shard_files = sorted(args.data_dir.glob("shard*.npz"))
    if not shard_files:
        raise SystemExit(f"no shard*.npz files found under {args.data_dir}")
    for path in shard_files:
        with np.load(path, allow_pickle=False) as shard:
            for row, idx in enumerate(np.asarray(shard["idx"], dtype=np.int64)):
                rows.append((int(idx), np.asarray(shard["final_mean"][row], dtype=np.float64), path.name))
    rows.sort(key=lambda value: value[0])
    if args.count > len(rows):
        raise SystemExit(f"requested {args.count} networks but only {len(rows)} are available")
    selected_positions = np.random.default_rng(args.seed).choice(len(rows), args.count, replace=False)
    selected = [rows[int(position)] for position in selected_positions]

    prefix = args.output_prefix
    prefix.parent.mkdir(parents=True, exist_ok=True)
    weights_path = prefix.with_suffix(".npy")
    partial_path = weights_path.with_name(weights_path.name + ".partial")
    targets_path = prefix.with_suffix(".targets.npz")
    manifest_path = prefix.with_suffix(".manifest.json")
    if any(path.exists() for path in (weights_path, partial_path, targets_path, manifest_path)):
        raise SystemExit("an output artifact already exists; choose a fresh output prefix")

    bank = np.lib.format.open_memmap(partial_path, mode="w+", dtype=np.float32,
                                     shape=(args.count, 16, 1024, 1024))
    indices, targets, hashes, source_shards = [], [], [], []
    torch.set_num_threads(1)
    try:
        for pos, (idx, target, shard_name) in enumerate(selected):
            generator = torch.Generator(device="cpu").manual_seed(args.weight_seed0 + idx)
            tensor = torch.randn((16, 1024, 1024), generator=generator, dtype=torch.float32)
            tensor.mul_((2.0 / 1024.0) ** 0.5)
            payload = memoryview(tensor.numpy()).cast("B")
            digest = sha256(payload)
            bank[pos] = tensor.numpy()
            indices.append(idx)
            targets.append(target)
            hashes.append(digest)
            source_shards.append(shard_name)
            if (pos + 1) % 8 == 0:
                bank.flush()
                print(f"generated {pos + 1}/{args.count} networks", flush=True)
        bank.flush()
        del bank
        os.replace(partial_path, weights_path)
    except BaseException:
        try:
            del bank
        except UnboundLocalError:
            pass
        raise

    np.savez_compressed(targets_path, idx=np.asarray(indices, dtype=np.int64),
                        final_mean=np.stack(targets))
    manifest = {
        "source": "keenanpepper/arc-whestbench-p2-d8b-corpus-14k",
        "source_card": "https://huggingface.co/datasets/keenanpepper/arc-whestbench-p2-d8b-corpus-14k",
        "weight_seed_recipe": f"torch.Generator(device='cpu').manual_seed({args.weight_seed0} + corpus_idx); torch.randn((16,1024,1024), float32) * sqrt(2/1024)",
        "selection_seed": args.seed,
        "selection_policy": "uniform without replacement from all downloaded shard rows",
        "corpus_indices": indices,
        "source_shard_by_network": source_shards,
        "weight_sha256": hashes,
        "shape": [args.count, 16, 1024, 1024],
        "dtype": "float32",
        "targets_path": str(targets_path),
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"weights": str(weights_path), "targets": str(targets_path),
                      "manifest": str(manifest_path), "count": args.count,
                      "indices": indices}, indent=2))


if __name__ == "__main__":
    main()
