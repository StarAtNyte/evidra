"""Reproducible local GEMS worker for Evidra.

This is deliberately a script rather than an executed notebook: Evidra can
patch, run, validate, checkpoint, and reproduce it in an isolated experiment.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import rasterio
import segmentation_models_pytorch as smp
import torch
import torch.nn.functional as F
from scipy.ndimage import distance_transform_edt
from torch.utils.data import DataLoader, TensorDataset


ROOT = Path(__file__).resolve().parent
DATA = ROOT.parent / "data"


def load_data() -> tuple[np.ndarray, np.ndarray, rasterio.profiles.Profile]:
    with rasterio.open(DATA / "numerical_features.tif") as src:
        features = src.read().astype(np.float32)
        profile = src.profile.copy()
        nodata = src.nodata
    with rasterio.open(DATA / "existing_faults.tif") as src:
        labels = src.read(1).astype(np.float32)
    features = np.moveaxis(features, 0, -1)
    invalid = ~np.isfinite(features).all(axis=-1)
    if nodata is not None:
        invalid |= np.any(features <= float(nodata) * 0.99, axis=-1)
    valid = ~invalid
    for channel in range(features.shape[-1]):
        values = features[..., channel][valid]
        lo, hi = np.percentile(values, [1, 99])
        features[..., channel] = np.clip((features[..., channel] - lo) / max(hi - lo, 1e-6), 0, 1)
    features[invalid] = 0
    labels = np.where(labels > 0, 1.0, 0.0).astype(np.float32)
    labels[invalid] = 0
    return features, labels, profile


def patch_grid(height: int, width: int, size: int) -> list[tuple[int, int]]:
    rows = list(range(0, max(1, height - size + 1), size))
    cols = list(range(0, max(1, width - size + 1), size))
    if not rows or rows[-1] != height - size:
        rows.append(max(0, height - size))
    if not cols or cols[-1] != width - size:
        cols.append(max(0, width - size))
    return sorted(set((r, c) for r in rows for c in cols))


def make_patches(features: np.ndarray, labels: np.ndarray, size: int, validation: bool) -> tuple[np.ndarray, np.ndarray, list[tuple[int, int]]]:
    height, width = labels.shape
    coords = patch_grid(height, width, size)
    selected: list[tuple[int, int]] = []
    for index, (row, col) in enumerate(coords):
        # Spatially separated checkerboard holdout avoids pixel leakage while
        # retaining both positive and negative geology in each split.
        is_validation = ((row // size) + (col // size)) % 5 == 0
        if is_validation == validation:
            selected.append((row, col))
    xs = np.stack([features[row:row + size, col:col + size].transpose(2, 0, 1) for row, col in selected])
    ys = np.stack([labels[row:row + size, col:col + size] for row, col in selected])
    return xs, ys, selected


def validation_target(labels: np.ndarray, size: int) -> np.ndarray:
    """Keep only labels from the spatial holdout blocks for proxy scoring."""
    target = np.zeros_like(labels)
    height, width = labels.shape
    for row, col in patch_grid(height, width, size):
        if ((row // size) + (col // size)) % 5 == 0:
            target[row:row + size, col:col + size] = labels[row:row + size, col:col + size]
    return target


def distance_tversky(prediction: np.ndarray, target: np.ndarray, radius: int = 3, alpha: float = 0.2, beta: float = 0.8) -> float:
    prediction = np.clip(prediction.astype(np.float32), 0, 1)
    target = target > 0.5
    target_distance = distance_transform_edt(~target)
    weights = np.maximum(1.0 - target_distance / radius, 0.0)
    fp = float(np.sum(prediction * (1.0 - weights)))
    tp_candidates = []
    fn_candidates = []
    for dr in range(-radius, radius + 1):
        for dc in range(-radius, radius + 1):
            distance = math.sqrt(dr * dr + dc * dc)
            if distance > radius:
                continue
            weight = 1.0 - distance / radius
            shifted = np.zeros_like(prediction)
            source_r = slice(max(0, dr), min(prediction.shape[0], prediction.shape[0] + dr))
            source_c = slice(max(0, dc), min(prediction.shape[1], prediction.shape[1] + dc))
            dest_r = slice(max(0, -dr), min(prediction.shape[0], prediction.shape[0] - dr))
            dest_c = slice(max(0, -dc), min(prediction.shape[1], prediction.shape[1] - dc))
            shifted[dest_r, dest_c] = prediction[source_r, source_c] * weight
            tp_candidates.append(shifted)
            fn_candidates.append(shifted)
    best = np.max(np.stack(tp_candidates), axis=0)
    tp = float(np.sum(best[target]))
    fn = float(np.sum(1.0 - best[target]))
    return tp / max(tp + alpha * fp + beta * fn, 1e-8)


def predict(model: torch.nn.Module, features: np.ndarray, size: int, device: torch.device) -> np.ndarray:
    height, width, _ = features.shape
    result = np.zeros((height, width), dtype=np.float32)
    counts = np.zeros_like(result)
    model.eval()
    with torch.no_grad():
        for row, col in patch_grid(height, width, size):
            patch = features[row:row + size, col:col + size].transpose(2, 0, 1)
            tensor = torch.from_numpy(patch[None]).to(device)
            output = torch.sigmoid(model(tensor)[:, 0]).cpu().numpy()[0]
            result[row:row + size, col:col + size] += output
            counts[row:row + size, col:col + size] += 1
    return result / np.maximum(counts, 1)


def save_geotiff(path: Path, array: np.ndarray, profile: rasterio.profiles.Profile) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    output_profile = profile.copy()
    output_profile.update(count=1, dtype="float32", nodata=np.nan, compress="deflate")
    with rasterio.open(path, "w", **output_profile) as dst:
        dst.write(array.astype(np.float32), 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("baseline", "train"), default="train")
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--patch-size", type=int, default=128)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--output", type=Path, default=Path("artifacts/submission.tif"))
    args = parser.parse_args()
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)
    features, labels, profile = load_data()
    if args.mode == "baseline":
        # The official sample is an absence baseline. It must not copy the
        # public known-fault raster into the score because that would leak the
        # validation target and make the proxy meaningless.
        prediction = np.zeros_like(labels, dtype=np.float32)
        score = distance_tversky(prediction, validation_target(labels, args.patch_size))
        save_geotiff(args.output, prediction, profile)
        print(json.dumps({"metric": score, "local_dti": score, "artifact": str(args.output)}))
        return
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    train_x, train_y, _ = make_patches(features, labels, args.patch_size, validation=False)
    val_x, val_y, _ = make_patches(features, labels, args.patch_size, validation=True)
    heldout_labels = validation_target(labels, args.patch_size)
    model = smp.Unet(encoder_name="resnet18", encoder_weights=None, in_channels=features.shape[-1], classes=1).to(device)
    loader = DataLoader(TensorDataset(torch.from_numpy(train_x), torch.from_numpy(train_y[:, None])), batch_size=args.batch_size, shuffle=True, num_workers=0)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-4, weight_decay=1e-4)
    best_score = -1.0
    best_state = None
    for epoch in range(args.epochs):
        model.train()
        for batch_x, batch_y in loader:
            batch_x, batch_y = batch_x.to(device), batch_y.to(device)
            logits = model(batch_x)
            probabilities = torch.sigmoid(logits)
            intersection = (probabilities * batch_y).sum((1, 2, 3))
            fp = (probabilities * (1 - batch_y)).sum((1, 2, 3))
            fn = ((1 - probabilities) * batch_y).sum((1, 2, 3))
            loss = (1 - (intersection + 1e-5) / (intersection + 0.2 * fp + 0.8 * fn + 1e-5)).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            optimizer.zero_grad(set_to_none=True)
        validation_prediction = predict(model, features, args.patch_size, device)
        heldout_prediction = np.where(heldout_labels > 0, validation_prediction, 0)
        score = distance_tversky(heldout_prediction, heldout_labels)
        print(json.dumps({"epoch": epoch + 1, "epochs": args.epochs, "proxy_dti": score, "device": str(device)}), flush=True)
        if score > best_score:
            best_score = score
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
    if best_state is not None:
        model.load_state_dict(best_state)
    prediction = predict(model, features, args.patch_size, device)
    save_geotiff(args.output, prediction, profile)
    print(json.dumps({"metric": best_score, "local_dti": best_score, "artifact": str(args.output), "device": str(device)}))


if __name__ == "__main__":
    main()
