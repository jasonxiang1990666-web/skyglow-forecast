import io
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import httpx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from ecmwf.opendata import Client as ECMWFClient
from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

app = FastAPI(title="Model Image Renderer", version="1.0.0")


class Bounds(BaseModel):
    west: float
    east: float
    south: float
    north: float


class RenderRequest(BaseModel):
    source: str = Field(pattern="^(EC|GFS)$")
    city: str
    latitude: float
    longitude: float
    runAt: int
    validAt: int
    targetAt: int
    scene: str = Field(pattern="^(sunrise|sunset)$")
    bounds: Bounds


def authenticate(authorization: str | None):
    expected = os.getenv("MODEL_RENDERER_TOKEN", "")
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="invalid renderer token")


def utc_time(milliseconds: int) -> datetime:
    return datetime.fromtimestamp(milliseconds / 1000, tz=timezone.utc)


def gfs_url(run_at: datetime, step: int, bounds: Bounds) -> str:
    date_part = run_at.strftime("%Y%m%d")
    hour = run_at.strftime("%H")
    filename = f"gfs.t{hour}z.pgrb2.0p25.f{step:03d}"
    return (
        "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?"
        f"file={filename}&lev_entire_atmosphere=on&var_TCDC=on&subregion="
        f"&leftlon={bounds.west}&rightlon={bounds.east}&toplat={bounds.north}&bottomlat={bounds.south}"
        f"&dir=%2Fgfs.{date_part}%2F{hour}%2Fatmos"
    )


def download_gfs(request: RenderRequest, target: Path) -> int:
    run_at = utc_time(request.runAt)
    step = max(0, round((request.validAt - request.runAt) / 3600000))
    url = gfs_url(run_at, step, request.bounds)
    with httpx.Client(timeout=40.0, follow_redirects=True) as client:
        response = client.get(url)
        response.raise_for_status()
        if len(response.content) < 500:
            raise RuntimeError("GFS 返回内容过小，目标起报或预报时效暂不可用")
        target.write_bytes(response.content)
    return int(request.validAt)


def download_ec(request: RenderRequest, target: Path) -> tuple[int, int]:
    snapshot_run = utc_time(request.runAt)
    # ECMWF HRES Open Data uses the 00 and 12 UTC atmospheric cycles.  The
    # numerical snapshot can have a provider-labelled 06/18 run, so choose the
    # most recent actual HRES cycle before its requested valid time.
    run_hour = 12 if snapshot_run.hour >= 12 else 0
    run_at = snapshot_run.replace(hour=run_hour, minute=0, second=0, microsecond=0)
    requested_step = max(0, round((request.validAt - int(run_at.timestamp() * 1000)) / 3600000))
    # ECMWF Open Data IFS HRES surface fields are published every three hours.
    step = max(0, int(round(requested_step / 3.0) * 3))
    # The primary ECMWF mirror can briefly lag while a new run is published.
    # AWS is an official Open Data mirror; use it first, then fall back to the
    # primary endpoint if needed.
    errors = []
    for source in ("aws", "ecmwf"):
        try:
            client = ECMWFClient(source=source)
            client.retrieve(
                date=run_at.strftime("%Y%m%d"),
                time=run_at.strftime("%H"),
                stream="oper",
                type="fc",
                levtype="sfc",
                param="tcc",
                step=step,
                target=str(target),
            )
            if target.exists() and target.stat().st_size >= 500:
                break
        except Exception as exc:
            errors.append(f"{source}: {exc}")
            target.unlink(missing_ok=True)
    else:
        raise RuntimeError("ECMWF Open Data mirror unavailable: " + " | ".join(errors))
    if not target.exists() or target.stat().st_size < 500:
        raise RuntimeError("EC 返回内容过小，目标起报或预报时效暂不可用")
    return int(run_at.timestamp() * 1000) + step * 3600000, int(run_at.timestamp() * 1000)


def find_coord(dataset, names):
    for name in names:
        if name in dataset.coords:
            return dataset[name].values
        if name in dataset:
            return dataset[name].values
    raise RuntimeError("GRIB 图层缺少经纬度坐标")


def cloud_field(path: Path):
    dataset = xr.open_dataset(path, engine="cfgrib", backend_kwargs={"indexpath": ""})
    try:
        if not dataset.data_vars:
            raise RuntimeError("GRIB 图层中没有云量字段")
        name = "tcc" if "tcc" in dataset.data_vars else next(iter(dataset.data_vars))
        values = np.asarray(dataset[name].squeeze().values, dtype=float)
        lats = np.asarray(find_coord(dataset, ["latitude", "lat"]), dtype=float)
        lons = np.asarray(find_coord(dataset, ["longitude", "lon"]), dtype=float)
    finally:
        dataset.close()
    if values.size == 0:
        raise RuntimeError("云量字段为空")
    if np.nanmax(values) <= 1.2:
        values = values * 100
    return lats, lons, np.clip(values, 0, 100)


def make_png(request: RenderRequest, lats, lons, values, effective_valid_at: int) -> bytes:
    figure, axis = plt.subplots(figsize=(7.2, 5.1), dpi=150)
    figure.patch.set_facecolor("#f8fbff")
    axis.set_facecolor("#edf5fb")
    mesh = axis.pcolormesh(lons, lats, values, cmap="Blues", shading="auto", vmin=0, vmax=100)
    axis.scatter(request.longitude, request.latitude, s=28, color="#a75120", edgecolors="white", linewidths=0.8, zorder=3)
    axis.set_xlim(request.bounds.west, request.bounds.east)
    axis.set_ylim(request.bounds.south, request.bounds.north)
    axis.set_xlabel("Longitude")
    axis.set_ylabel("Latitude")
    axis.grid(color="#ffffff", alpha=0.45, linewidth=0.55)
    source_label = "ECMWF IFS" if request.source == "EC" else "NOAA GFS"
    title = "Shanghai next dawn" if request.scene == "sunrise" else "Shanghai next dusk"
    axis.set_title(f"{source_label} total cloud cover · {title}", loc="left", fontsize=11, fontweight="bold")
    colourbar = figure.colorbar(mesh, ax=axis, pad=0.02, shrink=0.84)
    colourbar.set_label("Total cloud cover (%)")
    valid_text = utc_time(effective_valid_at).strftime("%Y-%m-%d %H:%M UTC")
    run_text = utc_time(request.runAt).strftime("%m-%d %H UTC")
    figure.text(0.125, 0.02, f"Run {run_text} · Valid {valid_text} · Rendered for Xia Guang Yu Jian", fontsize=7.5, color="#52657a")
    figure.tight_layout(rect=(0, 0.045, 1, 1))
    output = io.BytesIO()
    figure.savefig(output, format="png", bbox_inches="tight")
    plt.close(figure)
    return output.getvalue()


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/render")
def render(request: RenderRequest, authorization: str | None = Header(default=None)):
    authenticate(authorization)
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / "cloud.grib2"
        try:
            if request.source == "EC":
                effective_valid_at, effective_run_at = download_ec(request, target)
            else:
                effective_valid_at, effective_run_at = download_gfs(request, target), request.runAt
            lats, lons, values = cloud_field(target)
            image = make_png(request, lats, lons, values, effective_valid_at)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"{request.source} cloud render failed: {exc}") from exc
    return Response(content=image, media_type="image/png", headers={
        "X-Model-Effective-Valid-At": str(effective_valid_at),
        "X-Model-Effective-Run-At": str(effective_run_at),
    })
