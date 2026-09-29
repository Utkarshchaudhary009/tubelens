# Photoreal Desert Creature — reproducible Blender build

Photorealistic cinematic wildlife-film still recreating the reference llama-like
creature + pack-frame in a hazy desert canyon. 100% procedural, no external assets.

## Requirements

- Blender 4.x (`sudo apt-get install -y blender`), CPU-only Cycles is fine
- ffmpeg (optional, for video assembly)

## Re-run

```bash
blender -b -P scene.py
# output: blender_photoreal/render_photoreal.png (1920x816, 128 samples)
```

Custom output / frame:

```bash
blender -b -P scene.py -o //render_custom -f 1
```

## Verified build

- Blender 4.0.2 (apt, CPU Cycles), ffmpeg 6.1.1, Linux
- `blender -b -P scene.py` → `render_photoreal.png`, 1920x816, 128 samples
  (adaptive, threshold 0.01), ~17 min CPU render, ~2.5 MB. No GPU, no OIDN
  denoiser (not in this build), exposure −0.15. Previous version backed up as
  `render_v1.png`.
- Self-check: output exists, >100 KB, 1920x816, background renders (no black /
  missing world), no broken geometry; particle hair reports
  `head=True neck=True body=True` in the render log.

## What the script builds

- **Creature** — guanaco-like proxy: tapered wrinkled neck, dewlap folds,
  long snout + jaw + nose-leather nose (Voronoi pores, SSS) + nostril
  cavities + mouth slit + chin crease, cream cheek ruffs, upright ears, dark
  glossy eye assembly (amber iris, pupil, transmission-1.38 clearcoat cornea,
  thick upper/lower lids + lash line, dim catchlight fill — hero highlight is
  the real sun specular); fur = real particle guard-hair (head/neck/body,
  kink + clump + interpolated children) over combed flat-lying fuzz clumps,
  Principled sheen + SSS + noise bump + roughness variation + per-object tint
  jitter (no spike cones).
- **Pack-frame** — 4 jitter-weathered planks (procedural wood grain +
  Voronoi cracks/splits, roughness variation, Fresnel edge wear, bevel
  modifiers) with real slots over a dark AO backing board, crossbar
  cylinder, torus rope bindings + strap, procedural faded tribal-circle paint
  decal (orange rings / blue core / noise wear mask).
- **Environment/light/camera** — undulating mottled sand plane, 26
  subdivided + Clouds-displaced boulders, 70 scattered pebbles, ~90 grass
  tufts of thin tapered blades (two dry tones), floating mesa slabs, 6 hazy
  desaturated mauve-blue spires; pink-peach Normal-Z gradient sky with warm
  sun-glow spot (no world volume — infinite volumes black out the
  background); warm low side/back sun key, cool blue area shadow fill, cool
  rim, low warm bounce + blob contact shadow under the creature (warm
  highlights / cool shadows); 65mm camera left-third, f/2.0 DOF focused on
  hero eye; 128 samples, 1920x816.
