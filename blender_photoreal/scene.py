"""
TubeLens photoreal recreation — procedural cinematic wildlife-film still.

Reproducible build: no external assets, no manual .blend work.
Run headless (CPU Cycles, no GPU needed):

    blender -b -P scene.py

Output: blender_photoreal/render_photoreal.png (1920x816, 128 samples)

Composition matches the reference: close-up guanaco/vicuna-like creature in
left-center foreground (long snout, huge dark eye with catchlight, dense
tan/cream + rust-orange fur, long wrinkled neck), weathered wooden pack-frame
on its back (planks + crossbar + rope + faded tribal circle paint), hazy
pink-peach desert canyon valley with boulders, dry grass, blue mountain
spires, floating mesas, dusty atmosphere, warm cinematic light.

v2 photoreal pass: real particle guard-hair + combed mane (no spike cones),
nostrils + nose leather + mouth/chin detail, cornea/iris/pupil eye assembly
with dimmed catchlight (real sun specular dominates), cracked edge-worn wood
with dark plank gaps, displaced rocks + pebbles + blade grass tufts, warm low
side/back key + cool fill + blob contact shadow, hazy far mats + stronger DOF
+ sky sun glow.

v3 face pass: long tapered profile muzzle (bridge/blaze/wrinkle rings),
sculpted nostril rims + cavities + philtrum, smile-line mouth + lip/chin/tuft,
thick lids + fold + limbal ring + tear duct + lash fringe + iris fibers,
short groomed snout fur, tall upright ears with inners + rim fuzz.

v4 face fix: short 3/4-front muzzle (~0.47 long, forward-left toward camera,
no side-profile Ry), rounded snout + front-tip nose leather + small symmetric
nostrils + short philtrum, thin jaw-hugging mouth seam + rear-only smile
upturn, large hero eye with thin lids (lash-line/fold tori removed).
"""

import math
import os
import random
import time

import bpy
import mathutils

# --------------------------------------------------------------------------
# Setup / reproducibility
# --------------------------------------------------------------------------
RNG = random.Random(7)
T0 = time.time()
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(OUT_DIR, "render_photoreal.png")
os.makedirs(OUT_DIR, exist_ok=True)

# Wipe default scene
bpy.ops.wm.read_factory_settings(use_empty=True)

scene = bpy.context.scene
scene.name = "PhotorealDesert"
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 128
scene.cycles.use_adaptive_sampling = True
scene.cycles.adaptive_threshold = 0.01
try:
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOIDENOISE" if False else "OPENIMAGEDENOISE"
except Exception as e:
    print("Denoiser unavailable, continuing without:", e)
    try:
        scene.cycles.use_denoising = False
    except Exception:
        pass
scene.cycles.volume_step_size = 0.5
scene.cycles.volume_max_steps = 8  # keep world haze cheap
scene.render.resolution_x = 1920
scene.render.resolution_y = 816  # ~2.35:1 cinematic, matches ref aspect
scene.render.resolution_percentage = 100
scene.render.film_transparent = False
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGB"
scene.render.filepath = OUT_PATH
# Higher-contrast filmic-style response (AgX on full builds; this env may only
# expose NONE, so try in order and keep whatever sticks)
for _vt in ("AgX", "Filmic", "Standard"):
    try:
        scene.view_settings.view_transform = _vt
        break
    except Exception:
        continue
for _look in ("Medium High Contrast", "High Contrast", "Very High Contrast"):
    try:
        scene.view_settings.look = _look
        break
    except Exception:
        continue
scene.view_settings.exposure = -0.05  # lifted slightly so face detail reads
scene.render.use_motion_blur = False


def set_socket(node, names, value):
    """Set a Principled-BSDF-style socket, tolerating renames across versions."""
    if isinstance(names, str):
        names = [names]
    for n in names:
        if n in node.inputs:
            try:
                node.inputs[n].default_value = value
                return True
            except Exception:
                return False
    return False


def PSET(obj, key, value):
    """Set an attribute (e.g. version-sensitive particle setting), ignore if missing."""
    try:
        setattr(obj, key, value)
        return True
    except Exception:
        return False


def principled(name, base_color, roughness=0.8, metallic=0.0, extra=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    set_socket(bsdf, "Base Color", base_color)
    set_socket(bsdf, "Roughness", roughness)
    set_socket(bsdf, "Metallic", metallic)
    if extra:
        extra(bsdf, mat)
    return mat


def add_noise_bump(mat, scale=4.0, detail=3.0, strength=0.35, distortion=0.6):
    """Fur/sand/wood micro-relief: Noise -> Bump -> Normal (robust fuzz)."""
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = detail
    tex.inputs["Distortion"].default_value = distortion
    bump = tree.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    tree.links.new(tex.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    return tex


def add_roughness_variation(mat, scale=5.0, lo=0.65, hi=0.95):
    """Break up flat CG shading: Noise -> MapRange -> Roughness."""
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    tex = tree.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = 3.0
    mr = tree.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = 0.25
    mr.inputs["From Max"].default_value = 0.75
    mr.inputs["To Min"].default_value = lo
    mr.inputs["To Max"].default_value = hi
    tree.links.new(tex.outputs["Fac"], mr.inputs["Value"])
    tree.links.new(mr.outputs["Result"], bsdf.inputs["Roughness"])
    return tex


def add_color_mottle(mat, scale, col_a, col_b, amount=0.5):
    """Large-scale albedo variation: Noise -> ColorRamp(A/B) -> Mix over base."""
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    try:
        base = tuple(bsdf.inputs["Base Color"].default_value)
    except Exception:
        base = col_a
    tex = tree.nodes.new("ShaderNodeTexNoise")
    tex.inputs["Scale"].default_value = scale
    tex.inputs["Detail"].default_value = 2.0
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = col_a
    ramp.color_ramp.elements[1].color = col_b
    mix = tree.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MIX"
    mix.inputs["Fac"].default_value = amount
    mix.inputs[1].default_value = (base[0], base[1], base[2], 1.0)
    tree.links.new(ramp.outputs["Color"], mix.inputs[2])
    tree.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])
    return tex


def add_object_random_tint(mat, tint, amount=0.30):
    """Per-object hue jitter so shared fur mats don't look cloned."""
    tree = mat.node_tree
    bsdf = tree.nodes.get("Principled BSDF")
    try:
        base = tuple(bsdf.inputs["Base Color"].default_value)
    except Exception:
        return
    oi = tree.nodes.new("ShaderNodeObjectInfo")
    m = tree.nodes.new("ShaderNodeMath")
    m.operation = "MULTIPLY"
    m.inputs[1].default_value = amount
    tree.links.new(oi.outputs["Random"], m.inputs[0])
    mix = tree.nodes.new("ShaderNodeMixRGB")
    mix.blend_type = "MIX"
    mix.inputs[1].default_value = (base[0], base[1], base[2], 1.0)
    mix.inputs[2].default_value = tint
    tree.links.new(m.outputs["Value"], mix.inputs["Fac"])
    tree.links.new(mix.outputs["Color"], bsdf.inputs["Base Color"])


def new_mesh_object(name, verts, faces, mat=None):
    mesh = bpy.data.meshes.new(name + "Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj


def look_at(obj, target):
    d = (mathutils.Vector(target) - obj.location)
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def shade_smooth(obj):
    for p in obj.data.polygons:
        p.use_smooth = True


# --------------------------------------------------------------------------
# Materials
# --------------------------------------------------------------------------
# Dense fuzzy fur: warm tan with sheen (fuzz) + SSS (skin translucency) + bump
# + roughness variation + per-object tint jitter (no flat CG fur)
def _fur_extra(bsdf, mat):
    set_socket(bsdf, ["Subsurface Weight", "Subsurface"], 0.22)
    set_socket(bsdf, ["Subsurface Color", "Subsurface Radius"], (0.45, 0.22, 0.12, 1.0))
    set_socket(bsdf, ["Sheen Weight", "Sheen"], 0.6)
    set_socket(bsdf, ["Sheen Roughness", "Sheen Tint"], 0.55)
    set_socket(bsdf, ["Specular IOR Level", "Specular"], 0.35)


fur_tan = principled("FurTan", (0.66, 0.50, 0.34, 1.0), 0.92, extra=_fur_extra)
add_noise_bump(fur_tan, scale=9.0, strength=0.18, distortion=1.0)
add_roughness_variation(fur_tan, scale=6.0, lo=0.70, hi=0.97)
add_color_mottle(fur_tan, 2.2, (0.60, 0.44, 0.29, 1.0), (0.72, 0.56, 0.39, 1.0), 0.55)
add_object_random_tint(fur_tan, (0.78, 0.62, 0.42, 1.0), 0.25)
fur_cream = principled("FurCream", (0.83, 0.74, 0.60, 1.0), 0.95, extra=_fur_extra)
add_noise_bump(fur_cream, scale=11.0, strength=0.15, distortion=1.0)
add_roughness_variation(fur_cream, scale=7.0, lo=0.75, hi=0.98)
add_object_random_tint(fur_cream, (0.88, 0.80, 0.66, 1.0), 0.25)
fur_rust = principled("FurRust", (0.55, 0.26, 0.10, 1.0), 0.9, extra=_fur_extra)
add_noise_bump(fur_rust, scale=8.0, strength=0.18, distortion=0.8)
add_roughness_variation(fur_rust, scale=5.0, lo=0.68, hi=0.95)
add_color_mottle(fur_rust, 2.6, (0.48, 0.22, 0.09, 1.0), (0.62, 0.32, 0.13, 1.0), 0.5)


def _eye_extra(bsdf, mat):
    # dark glossy eyeball: sharp real sun specular
    set_socket(bsdf, ["Specular IOR Level", "Specular"], 1.0)
    set_socket(bsdf, ["Coat Weight", "Clearcoat"], 0.6)
    set_socket(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.08)


eye_mat = principled("EyeDark", (0.045, 0.025, 0.016, 1.0), 0.05, extra=_eye_extra)


def _cornea_extra(bsdf, mat):
    set_socket(bsdf, ["Transmission Weight", "Transmission"], 1.0)
    set_socket(bsdf, ["IOR", "Transmission IOR"], 1.38)
    set_socket(bsdf, ["Coat Weight", "Clearcoat"], 1.0)
    set_socket(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.03)
    set_socket(bsdf, ["Specular IOR Level", "Specular"], 1.0)


cornea_mat = principled("Cornea", (1.0, 1.0, 1.0, 1.0), 0.03, extra=_cornea_extra)

iris_mat = principled("Iris", (0.30, 0.15, 0.06, 1.0), 0.35)
add_color_mottle(iris_mat, 7.0, (0.16, 0.07, 0.03, 1.0), (0.55, 0.32, 0.12, 1.0), 0.8)
# radial iris fibers: streaky wave variation mixed over the base amber
_it = iris_mat.node_tree
_ib = _it.nodes.get("Principled BSDF")
_wave = _it.nodes.new("ShaderNodeTexWave")
_wave.inputs["Scale"].default_value = 14.0
_wave.inputs["Distortion"].default_value = 3.0
_wramp = _it.nodes.new("ShaderNodeValToRGB")
_wramp.color_ramp.elements[0].color = (0.20, 0.09, 0.03, 1.0)
_wramp.color_ramp.elements[1].color = (0.72, 0.45, 0.18, 1.0)
_imix = _it.nodes.new("ShaderNodeMixRGB")
_imix.blend_type = "MIX"
_imix.inputs["Fac"].default_value = 0.55
_imix.inputs[1].default_value = (0.30, 0.15, 0.06, 1.0)
_it.links.new(_wave.outputs["Fac"], _wramp.inputs["Fac"])
_it.links.new(_wramp.outputs["Color"], _imix.inputs[2])
_it.links.new(_imix.outputs["Color"], _ib.inputs["Base Color"])
pupil_mat = principled("Pupil", (0.008, 0.006, 0.005, 1.0), 0.04, extra=_eye_extra)


def _nose_extra(bsdf, mat):
    # nose leather: low roughness, pores, reddish SSS
    set_socket(bsdf, ["Subsurface Weight", "Subsurface"], 0.30)
    set_socket(bsdf, ["Subsurface Color", "Subsurface Radius"], (0.35, 0.12, 0.09, 1.0))
    set_socket(bsdf, ["Specular IOR Level", "Specular"], 0.7)
    set_socket(bsdf, ["Coat Weight", "Clearcoat"], 0.35)
    set_socket(bsdf, ["Coat Roughness", "Clearcoat Roughness"], 0.25)


nose_mat = principled("NoseLeather", (0.15, 0.11, 0.095, 1.0), 0.42, extra=_nose_extra)
# nose pores: fine Voronoi pits -> bump
_nt = nose_mat.node_tree
_nbsdf = _nt.nodes.get("Principled BSDF")
_pore = _nt.nodes.new("ShaderNodeTexVoronoi")
PSET(_pore, "feature", "F1")
_pore.inputs["Scale"].default_value = 80.0
_pbump = _nt.nodes.new("ShaderNodeBump")
_pbump.inputs["Strength"].default_value = 0.25
_pbump.inputs["Distance"].default_value = 0.02
_nt.links.new(_pore.outputs["Distance"], _pbump.inputs["Height"])
_nt.links.new(_pbump.outputs["Normal"], _nbsdf.inputs["Normal"])
add_roughness_variation(nose_mat, scale=18.0, lo=0.25, hi=0.5)

nostril_mat = principled("Nostril", (0.015, 0.010, 0.008, 1.0), 0.6)
mouth_mat = principled("Mouth", (0.10, 0.055, 0.04, 1.0), 0.65, extra=_nose_extra)
caruncle_mat = principled("Caruncle", (0.42, 0.18, 0.13, 1.0), 0.5, extra=_nose_extra)

# Dim glint only; the hero highlight must come from the real sun specular.
catch_mat = bpy.data.materials.new("Catchlight")
catch_mat.use_nodes = True
catch_mat.node_tree.nodes.get("Principled BSDF").inputs["Base Color"].default_value = (1, 1, 1, 1)
emit = catch_mat.node_tree.nodes.new("ShaderNodeEmission")
emit.inputs["Color"].default_value = (1.0, 0.93, 0.82, 1.0)
emit.inputs["Strength"].default_value = 2.2  # strong sun catchlight fill
out = catch_mat.node_tree.nodes.get("Material Output")
catch_mat.node_tree.links.new(emit.outputs[0], out.inputs[0])

# --- Weathered wood: grain + cracks/splits + roughness var + edge wear ---
wood_mat = principled("Wood", (0.42, 0.27, 0.13, 1.0), 0.82)
add_noise_bump(wood_mat, scale=6.0, strength=0.3, distortion=0.4)
_tree = wood_mat.node_tree
_grain = _tree.nodes.new("ShaderNodeTexNoise")
_grain.inputs["Scale"].default_value = 2.2
_grain.inputs["Detail"].default_value = 4.0
_ramp = _tree.nodes.new("ShaderNodeValToRGB")
_ramp.color_ramp.elements[0].color = (0.30, 0.18, 0.08, 1.0)
_ramp.color_ramp.elements[1].color = (0.52, 0.34, 0.17, 1.0)
_tree.links.new(_grain.outputs["Fac"], _ramp.inputs["Fac"])
_mix = _tree.nodes.new("ShaderNodeMixRGB")
_mix.blend_type = "MULTIPLY"
_mix.inputs["Fac"].default_value = 0.55
_bsdf = _tree.nodes.get("Principled BSDF")
_tree.links.new(_ramp.outputs["Color"], _mix.inputs[1])
_mix.inputs[2].default_value = (0.55, 0.38, 0.22, 1.0)
_tree.links.new(_mix.outputs["Color"], _bsdf.inputs["Base Color"])
# cracks/splits: Voronoi edges darken albedo + carve bump
_crack = _tree.nodes.new("ShaderNodeTexVoronoi")
PSET(_crack, "feature", "F1")
_crack.inputs["Scale"].default_value = 14.0
_cramp = _tree.nodes.new("ShaderNodeValToRGB")
_cramp.color_ramp.elements[0].position = 0.0
_cramp.color_ramp.elements[0].color = (0.05, 0.03, 0.015, 1.0)
_cramp.color_ramp.elements[1].position = 0.22
_cramp.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
_tree.links.new(_crack.outputs["Distance"], _cramp.inputs["Fac"])
_cmix = _tree.nodes.new("ShaderNodeMixRGB")
_cmix.blend_type = "MULTIPLY"
_cmix.inputs["Fac"].default_value = 0.65
_tree.links.new(_mix.outputs["Color"], _cmix.inputs[1])
_tree.links.new(_cramp.outputs["Color"], _cmix.inputs[2])
_tree.links.new(_cmix.outputs["Color"], _bsdf.inputs["Base Color"])
_cbump = _tree.nodes.new("ShaderNodeBump")
_cbump.inputs["Strength"].default_value = 0.6
_cbump.inputs["Distance"].default_value = 0.05
_tree.links.new(_crack.outputs["Distance"], _cbump.inputs["Height"])
# NOTE: bump Normal link replaces the earlier grain bump (cracks dominate); fine.
_tree.links.new(_cbump.outputs["Normal"], _bsdf.inputs["Normal"])
# roughness variation (sun-bleached patches vs grimy splits)
_rtex = _tree.nodes.new("ShaderNodeTexNoise")
_rtex.inputs["Scale"].default_value = 4.0
_rmr = _tree.nodes.new("ShaderNodeMapRange")
_rmr.inputs["From Min"].default_value = 0.2
_rmr.inputs["From Max"].default_value = 0.8
_rmr.inputs["To Min"].default_value = 0.55
_rmr.inputs["To Max"].default_value = 0.92
_tree.links.new(_rtex.outputs["Fac"], _rmr.inputs["Value"])
_tree.links.new(_rmr.outputs["Result"], _bsdf.inputs["Roughness"])
# bevel edge wear: pale rubbed-wood sheen on facing edges
_lw = _tree.nodes.new("ShaderNodeLayerWeight")
_lw.inputs["Blend"].default_value = 0.4
_wmask = _tree.nodes.new("ShaderNodeValToRGB")
_wmask.color_ramp.elements[0].position = 0.55
_wmask.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 1.0)
_wmask.color_ramp.elements[1].position = 0.95
_wmask.color_ramp.elements[1].color = (1.0, 1.0, 1.0, 1.0)
_tree.links.new(_lw.outputs["Fresnel"], _wmask.inputs["Fac"])
_wmix = _tree.nodes.new("ShaderNodeMixRGB")
_wmix.blend_type = "MIX"
_wmix.inputs["Fac"].default_value = 0.40
_wmix.inputs[2].default_value = (0.68, 0.50, 0.30, 1.0)  # worn pale wood
_tree.links.new(_cmix.outputs["Color"], _wmix.inputs[1])
_tree.links.new(_wmask.outputs["Color"], _wmix.inputs["Fac"])
_tree.links.new(_wmix.outputs["Color"], _bsdf.inputs["Base Color"])
# dark gap/backing material: near-black crevices between planks
gap_mat = principled("PlankGap", (0.05, 0.032, 0.02, 1.0), 0.95)

rope_mat = principled("Rope", (0.50, 0.36, 0.20, 1.0), 0.95)
add_noise_bump(rope_mat, scale=14.0, strength=0.25)
add_roughness_variation(rope_mat, scale=9.0, lo=0.8, hi=1.0)

sand_mat = principled("Sand", (0.80, 0.60, 0.44, 1.0), 0.96)
add_noise_bump(sand_mat, scale=3.0, strength=0.15, distortion=0.7)
add_color_mottle(sand_mat, 1.4, (0.72, 0.52, 0.37, 1.0), (0.87, 0.68, 0.51, 1.0), 0.6)
add_roughness_variation(sand_mat, scale=4.0, lo=0.9, hi=1.0)
rock_mat = principled("Rock", (0.60, 0.50, 0.42, 1.0), 0.93)
add_noise_bump(rock_mat, scale=5.0, strength=0.3, distortion=0.9)
add_color_mottle(rock_mat, 3.0, (0.52, 0.43, 0.36, 1.0), (0.68, 0.58, 0.49, 1.0), 0.55)
add_roughness_variation(rock_mat, scale=6.0, lo=0.8, hi=1.0)
grass_mat = principled("DryGrass", (0.60, 0.48, 0.27, 1.0), 0.95)
add_roughness_variation(grass_mat, scale=8.0, lo=0.85, hi=1.0)
grass_mat_b = principled("DryGrassGreen", (0.45, 0.42, 0.22, 1.0), 0.95)
add_roughness_variation(grass_mat_b, scale=8.0, lo=0.85, hi=1.0)
# Distance haze: desaturated blue-pink far materials (aerial perspective fake)
mesa_mat = principled("Mesa", (0.80, 0.60, 0.52, 1.0), 0.97)
add_noise_bump(mesa_mat, scale=2.0, strength=0.4)
add_color_mottle(mesa_mat, 0.8, (0.76, 0.58, 0.50, 1.0), (0.86, 0.66, 0.58, 1.0), 0.5)
mount_mat = principled("FarMountain", (0.68, 0.60, 0.70, 1.0), 1.0)  # hazy mauve-blue
float_mat = principled("FloatRock", (0.76, 0.60, 0.53, 1.0), 0.97)
add_color_mottle(float_mat, 1.2, (0.72, 0.57, 0.50, 1.0), (0.82, 0.65, 0.58, 1.0), 0.4)

# Faded tribal-circle paint decal (procedural concentric rings, worn by noise)
decal = bpy.data.materials.new("TribalDecal")
decal.use_nodes = True
dt = decal.node_tree
dt.nodes.clear()
tco = dt.nodes.new("ShaderNodeTexCoord")
tmap = dt.nodes.new("ShaderNodeMapping")
tmap.inputs["Scale"].default_value = (3.2, 3.2, 1.0)
tmap.inputs["Location"].default_value = (-1.6, -1.6, 0.0)  # center rings on plane
dt.links.new(tco.outputs["UV"], tmap.inputs["Vector"])
# radial distance from center
sep = dt.nodes.new("ShaderNodeSeparateXYZ")
dt.links.new(tmap.outputs["Vector"], sep.inputs["Vector"])
pwr = dt.nodes.new("ShaderNodeMath")
pwr.operation = "POWER"
pwr.inputs[1].default_value = 2.0
pwr2 = dt.nodes.new("ShaderNodeMath")
pwr2.operation = "POWER"
pwr2.inputs[1].default_value = 2.0
add = dt.nodes.new("ShaderNodeMath")
add.operation = "ADD"
sqt = dt.nodes.new("ShaderNodeMath")
sqt.operation = "SQRT"
dt.links.new(sep.outputs["X"], pwr.inputs[0])
dt.links.new(sep.outputs["Y"], pwr2.inputs[0])
dt.links.new(pwr.outputs["Value"], add.inputs[0])
dt.links.new(pwr2.outputs["Value"], add.inputs[1])
dt.links.new(add.outputs["Value"], sqt.inputs[0])
ring = dt.nodes.new("ShaderNodeTexNoise")  # ring banding via stretched noise
ring.inputs["Scale"].default_value = 9.0
ring.inputs["Detail"].default_value = 2.0
mult = dt.nodes.new("ShaderNodeMath")
mult.operation = "MULTIPLY"
dt.links.new(sqt.outputs["Value"], mult.inputs[0])
mult.inputs[1].default_value = 9.0
bands = dt.nodes.new("ShaderNodeMath")
bands.operation = "PINGPONG"
dt.links.new(mult.outputs["Value"], bands.inputs[0])
bands.inputs[1].default_value = 1.0
bands.inputs[2].default_value = 0.12  # thin orange rings
wear = dt.nodes.new("ShaderNodeTexNoise")  # paint wear mask
wear.inputs["Scale"].default_value = 5.0
wear.inputs["Detail"].default_value = 3.0
wth = dt.nodes.new("ShaderNodeMath")
wth.operation = "GREATER_THAN"
dt.links.new(wear.outputs["Fac"], wth.inputs[0])
wth.inputs[1].default_value = 0.35
alpha = dt.nodes.new("ShaderNodeMath")
alpha.operation = "MULTIPLY"
dt.links.new(bands.outputs["Value"], alpha.inputs[0])
dt.links.new(wth.outputs["Value"], alpha.inputs[1])
blue = dt.nodes.new("ShaderNodeRGB")
blue.outputs["Color"].default_value = (0.25, 0.45, 0.62, 1.0)  # faded blue core
core = dt.nodes.new("ShaderNodeMath")
core.operation = "LESS_THAN"
dt.links.new(sqt.outputs["Value"], core.inputs[0])
core.inputs[1].default_value = 0.38
cmix = dt.nodes.new("ShaderNodeMixRGB")
cmix.inputs["Fac"].default_value = 0.5
cmix.inputs[1].default_value = (0.75, 0.42, 0.15, 1.0)  # faded orange rings
dt.links.new(blue.outputs["Color"], cmix.inputs[2])
dt.links.new(core.outputs["Value"], cmix.inputs["Fac"])
bsdf_d = dt.nodes.new("ShaderNodeBsdfPrincipled")
bsdf_d.inputs["Base Color"].default_value = (0.7, 0.4, 0.15, 1.0)
dt.links.new(cmix.outputs["Color"], bsdf_d.inputs["Base Color"])
bsdf_d.inputs["Roughness"].default_value = 0.9
tout = dt.nodes.new("ShaderNodeOutputMaterial")
dt.links.new(bsdf_d.outputs["BSDF"], tout.inputs["Surface"])
dt.links.new(alpha.outputs["Value"], tout.inputs["Displacement"] if False else bsdf_d.inputs["Alpha"])
# alpha blend
decal.blend_method = "BLEND"

# Soft blob contact shadow under the creature (cheap AO grounding)
blob_mat = bpy.data.materials.new("BlobShadow")
blob_mat.use_nodes = True
bt = blob_mat.node_tree
bt.nodes.clear()
_btco = bt.nodes.new("ShaderNodeTexCoord")
_bsep = bt.nodes.new("ShaderNodeSeparateXYZ")
bt.links.new(_btco.outputs["UV"], _bsep.inputs["Vector"])
_bcx = bt.nodes.new("ShaderNodeMath")
_bcx.operation = "SUBTRACT"
_bcx.inputs[1].default_value = 0.5
bt.links.new(_bsep.outputs["X"], _bcx.inputs[0])
_bcy = bt.nodes.new("ShaderNodeMath")
_bcy.operation = "SUBTRACT"
_bcy.inputs[1].default_value = 0.5
bt.links.new(_bsep.outputs["Y"], _bcy.inputs[0])
_bxx = bt.nodes.new("ShaderNodeMath")
_bxx.operation = "POWER"
_bxx.inputs[1].default_value = 2.0
bt.links.new(_bcx.outputs["Value"], _bxx.inputs[0])
_byy = bt.nodes.new("ShaderNodeMath")
_byy.operation = "POWER"
_byy.inputs[1].default_value = 2.0
bt.links.new(_bcy.outputs["Value"], _byy.inputs[0])
_badd = bt.nodes.new("ShaderNodeMath")
_badd.operation = "ADD"
bt.links.new(_bxx.outputs["Value"], _badd.inputs[0])
bt.links.new(_byy.outputs["Value"], _badd.inputs[1])
_bsqrt = bt.nodes.new("ShaderNodeMath")
_bsqrt.operation = "SQRT"
bt.links.new(_badd.outputs["Value"], _bsqrt.inputs[0])
_bramp = bt.nodes.new("ShaderNodeValToRGB")
_bramp.color_ramp.elements[0].position = 0.05
_bramp.color_ramp.elements[0].color = (0.0, 0.0, 0.0, 0.55)
_bramp.color_ramp.elements[1].position = 0.5
_bramp.color_ramp.elements[1].color = (0.0, 0.0, 0.0, 0.0)
bt.links.new(_bsqrt.outputs["Value"], _bramp.inputs["Fac"])
_btrans = bt.nodes.new("ShaderNodeBsdfTransparent")
_bdiff = bt.nodes.new("ShaderNodeBsdfDiffuse")
_bdiff.inputs["Color"].default_value = (0.02, 0.015, 0.012, 1.0)
_bmix = bt.nodes.new("ShaderNodeMixShader")
bt.links.new(_bramp.outputs["Alpha"], _bmix.inputs["Fac"])
bt.links.new(_btrans.outputs["BSDF"], _bmix.inputs[1])
bt.links.new(_bdiff.outputs["BSDF"], _bmix.inputs[2])
_bout = bt.nodes.new("ShaderNodeOutputMaterial")
bt.links.new(_bmix.outputs["Shader"], _bout.inputs["Surface"])
blob_mat.blend_method = "BLEND"

# --------------------------------------------------------------------------
# World: pink-peach gradient sky + warm sun glow + dusty haze
# --------------------------------------------------------------------------
world = bpy.data.worlds.new("DesertWorld")
scene.world = world
world.use_nodes = True
wt = world.node_tree
wt.nodes.clear()
wout = wt.nodes.new("ShaderNodeOutputWorld")
bg = wt.nodes.new("ShaderNodeBackground")
# peach horizon -> pink -> dusty blue zenith via gradient
wtex = wt.nodes.new("ShaderNodeTexCoord")
wsep = wt.nodes.new("ShaderNodeSeparateXYZ")
wmaprange = wt.nodes.new("ShaderNodeMapRange")
wmaprange.inputs["From Min"].default_value = -0.08
wmaprange.inputs["From Max"].default_value = 0.65
wmaprange.inputs["To Min"].default_value = 0.0
wmaprange.inputs["To Max"].default_value = 1.0
wramp = wt.nodes.new("ShaderNodeValToRGB")
stops = wramp.color_ramp.elements
stops[0].position = 0.42
stops[0].color = (1.0, 0.70, 0.52, 1.0)   # peach horizon
m1 = wramp.color_ramp.elements.new(0.55)
m1.color = (0.98, 0.60, 0.56, 1.0)        # pink mid
m2 = wramp.color_ramp.elements.new(0.72)
m2.color = (0.70, 0.60, 0.68, 1.0)        # dusty mauve
stops[1].position = 1.0
stops[1].color = (0.42, 0.52, 0.70, 1.0)  # dusty blue zenith
wt.links.new(wtex.outputs["Normal"], wsep.inputs["Vector"])
wt.links.new(wsep.outputs["Z"], wmaprange.inputs["Value"])
wt.links.new(wmaprange.outputs["Result"], wramp.inputs["Fac"])
# sun glow: bright warm spot around the low sun direction (right-back of frame)
glow_dot = wt.nodes.new("ShaderNodeVectorMath")
glow_dot.operation = "DOT_PRODUCT"
glow_vec = mathutils.Vector((0.55, 0.78, 0.16)).normalized()
glow_dot.inputs[1].default_value = (glow_vec.x, glow_vec.y, glow_vec.z)
wt.links.new(wtex.outputs["Normal"], glow_dot.inputs[0])
glow_map = wt.nodes.new("ShaderNodeMapRange")
PSET(glow_map, "clamp", True)
glow_map.inputs["From Min"].default_value = 0.86
glow_map.inputs["From Max"].default_value = 1.0
glow_map.inputs["To Min"].default_value = 0.0
glow_map.inputs["To Max"].default_value = 1.0
wt.links.new(glow_dot.outputs["Value"], glow_map.inputs["Value"])
glow_pow = wt.nodes.new("ShaderNodeMath")
glow_pow.operation = "POWER"
glow_pow.inputs[1].default_value = 1.6
wt.links.new(glow_map.outputs["Result"], glow_pow.inputs[0])
glow_col = wt.nodes.new("ShaderNodeRGB")
glow_col.outputs["Color"].default_value = (1.0, 0.62, 0.38, 1.0)
glow_mul = wt.nodes.new("ShaderNodeMath")
glow_mul.operation = "MULTIPLY"
wt.links.new(glow_pow.outputs["Value"], glow_mul.inputs[0])
glow_mul.inputs[1].default_value = 1.4
sky_add = wt.nodes.new("ShaderNodeMixRGB")
sky_add.blend_type = "ADD"
sky_add.inputs["Fac"].default_value = 1.0
wt.links.new(wramp.outputs["Color"], sky_add.inputs[1])
wt.links.new(glow_col.outputs["Color"], sky_add.inputs[2])
# scale glow contribution by glow mask: use Fac mix instead of pure add
sky_mix = wt.nodes.new("ShaderNodeMixRGB")
sky_mix.blend_type = "MIX"
wt.links.new(wramp.outputs["Color"], sky_mix.inputs[1])
wt.links.new(sky_add.outputs["Color"], sky_mix.inputs[2])
wt.links.new(glow_mul.outputs["Value"], sky_mix.inputs["Fac"])
wt.links.new(sky_mix.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 0.85
# NOTE: no world volume — an infinite volume scatters background rays to black.
# Aerial haze is faked with hazy blue/desaturated background-geometry materials.
wt.links.new(bg.outputs["Background"], wout.inputs["Surface"])

# --------------------------------------------------------------------------
# Camera (left-third close-up, 65mm, f/2.0, eye in focus — stronger bg blur)
# --------------------------------------------------------------------------
cam_data = bpy.data.cameras.new("CineCam")
cam_data.lens = 65.0
cam_data.sensor_fit = "HORIZONTAL"
cam_data.dof.use_dof = True
cam_data.dof.aperture_fstop = 2.0
cam_data.dof.aperture_blades = 7
cam = bpy.data.objects.new("CineCam", cam_data)
scene.collection.objects.link(cam)
cam.location = (-2.7, -5.4, 2.15)
look_at(cam, (-0.05, 0.45, 1.30))
# nudge frame so creature sits left-third: slight shift
cam_data.shift_x = 0.14
scene.camera = cam

# DOF focus target = near eye (created below); placeholder empty for now
focus_empty = bpy.data.objects.new("EyeFocus", None)
scene.collection.objects.link(focus_empty)
cam_data.dof.focus_object = focus_empty

# --------------------------------------------------------------------------
# Lights: warm LOW side/back sun key, cool shadow fill, cool rim, soft bounce
# grade: warm highlights (key) vs cool shadows (fill) -> cinematic contrast
# --------------------------------------------------------------------------
sun = bpy.data.objects.new("SunKey", bpy.data.lights.new("SunKey", "SUN"))
sun.data.energy = 3.2
sun.data.color = (1.0, 0.60, 0.40)
# low elevation (~22 deg) from the right-back: long warm side light
sun.rotation_euler = (math.radians(68), math.radians(8), math.radians(-115))
scene.collection.objects.link(sun)

fill_data = bpy.data.lights.new("SkyFill", "AREA")
fill_data.energy = 18.0
fill_data.color = (0.55, 0.65, 0.90)  # cool shadow fill (front-left-top)
fill_data.shape = "RECTANGLE"
fill_data.size = 6.0
fill_data.size_y = 4.0
fill_obj = bpy.data.objects.new("SkyFill", fill_data)
fill_obj.location = (-4.5, -3.0, 3.4)
look_at(fill_obj, (-0.3, 0.3, 1.4))
scene.collection.objects.link(fill_obj)

rim_data = bpy.data.lights.new("RimCool", "SUN")
rim_data.energy = 0.9
rim_data.color = (0.62, 0.68, 0.9)
rim = bpy.data.objects.new("RimCool", rim_data)
rim.rotation_euler = (math.radians(60), 0, math.radians(55))
scene.collection.objects.link(rim)

bounce_data = bpy.data.lights.new("GroundBounce", "AREA")
bounce_data.energy = 6.0  # kept low so shadows stay cool and contrasty
bounce_data.color = (0.95, 0.70, 0.55)
bounce = bpy.data.objects.new("GroundBounce", bounce_data)
bounce.location = (1.5, -1.5, 0.4)
look_at(bounce, (-0.3, 0.3, 1.5))
scene.collection.objects.link(bounce)

# --------------------------------------------------------------------------
# Environment: ground, boulders, grass tufts, mesas, spires, floaters
# --------------------------------------------------------------------------
def jitter(obj, amt):
    mesh = obj.data
    for v in mesh.vertices:
        c = v.co
        n = (math.sin(c.x * 3.1 + c.y * 1.7) + math.cos(c.y * 2.3 + c.z * 4.1)
             + math.sin(c.z * 5.3 + c.x * 2.2)) / 3.0
        v.co = c + mathutils.Vector((n * amt, n * amt * 0.7, n * amt * 0.5))
    mesh.update()


def displace_clouds(obj, strength, scale=1.5):
    """Lumpy rock displacement via a Clouds texture (headless-safe)."""
    try:
        tex = bpy.data.textures.new("DispTex_%s" % obj.name, "CLOUDS")
        tex.noise_scale = scale
        mod = obj.modifiers.new("RockDisp", "DISPLACE")
        mod.texture = tex
        mod.texture_coords = "OBJECT"
        mod.strength = strength
        return True
    except Exception as e:
        print("displace skipped for", obj.name, e)
        return False


# Ground: 220x220 plane, gentle undulation, sand material
N = 48
SIZE = 110.0
verts, faces = [], []
for iy in range(N + 1):
    for ix in range(N + 1):
        x = -SIZE + 2 * SIZE * ix / N
        y = -SIZE + 2 * SIZE * iy / N
        z = (math.sin(x * 0.08) * math.cos(y * 0.06) * 1.2
             + math.sin(x * 0.35 + y * 0.3) * 0.15)
        # keep a flat "stage" near creature
        d = math.hypot(x + 0.3, y - 0.3)
        if d < 6:
            z *= d / 6.0 * 0.5
        verts.append((x, y, z - 0.02))
for iy in range(N):
    for ix in range(N):
        a = iy * (N + 1) + ix
        faces.append((a, a + 1, a + N + 2, a + N + 1))
ground = new_mesh_object("Ground", verts, faces, sand_mat)
shade_smooth(ground)

# Soft contact shadow blob under the creature
bpy.ops.mesh.primitive_plane_add(size=1.0, location=(0.10, 0.35, 0.015))
blob = bpy.context.view_layer.objects.active
blob.name = "ContactShadow"
blob.scale = (3.6, 2.8, 1.0)
blob.data.materials.clear()
blob.data.materials.append(blob_mat)

# Boulders: subdivided + displaced lumps scattered mid/background (hero clear)
for i in range(26):
    side = RNG.choice([-1, 1])
    x = RNG.uniform(2.5, 28) * (1 if i % 3 else -1) + RNG.uniform(-3, 3)
    y = RNG.uniform(-2, 30)
    if i < 8:  # a few near-midground right side like ref
        x = RNG.uniform(2.0, 9.0)
        y = RNG.uniform(0.5, 8.0)
    s = RNG.uniform(0.35, 1.6)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=s, location=(x, y, s * 0.35))
    b = bpy.context.view_layer.objects.active
    b.name = f"Boulder{i}"
    b.data.materials.append(rock_mat)
    displace_clouds(b, s * 0.35, scale=RNG.uniform(0.8, 1.6))
    jitter(b, s * 0.10)
    b.scale = (RNG.uniform(0.8, 1.4), RNG.uniform(0.7, 1.2), RNG.uniform(0.5, 0.8))
    shade_smooth(b)

# Scattered pebbles: near-camera grit so sand doesn't read as a flat plane
for i in range(70):
    x = RNG.uniform(-6, 8)
    y = RNG.uniform(-4, 9)
    if math.hypot(x + 0.3, y - 0.3) < 1.6:
        continue
    s = RNG.uniform(0.02, 0.07)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=s,
                                          location=(x, y, s * 0.5))
    pb = bpy.context.view_layer.objects.active
    pb.name = f"Pebble{i}"
    pb.data.materials.append(rock_mat if RNG.random() < 0.5 else sand_mat)
    jitter(pb, s * 0.25)
    shade_smooth(pb)

# Dry grass: per-tuft fans of thin tapered blades (not solid cones)
def make_grass_tuft(i, x, y):
    n_blades = RNG.randint(5, 7)
    h_base = RNG.uniform(0.20, 0.48)
    for k in range(n_blades):
        h = h_base * RNG.uniform(0.7, 1.2)
        r = RNG.uniform(0.008, 0.016)
        tilt = RNG.uniform(0.10, 0.45)
        az = (2 * math.pi * k / n_blades) + RNG.uniform(-0.4, 0.4)
        bx = x + math.cos(az) * 0.05
        by = y + math.sin(az) * 0.05
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=r, depth=h,
                                        location=(bx, by, h * 0.42))
        g = bpy.context.view_layer.objects.active
        g.name = f"Blade{i}_{k}"
        g.rotation_euler = (math.cos(az) * tilt, math.sin(az) * tilt,
                            RNG.uniform(0, 6.28))
        g.data.materials.append(grass_mat if RNG.random() < 0.6 else grass_mat_b)


_tuft = 0
_tries = 0
while _tuft < 90 and _tries < 500:
    _tries += 1
    x = RNG.uniform(-14, 26)
    y = RNG.uniform(-6, 26)
    if math.hypot(x + 0.3, y - 0.3) < 2.2:
        continue
    make_grass_tuft(_tuft, x, y)
    _tuft += 1

# Left floating mesa (ref: big flat-topped rock slab left background)
bpy.ops.mesh.primitive_cylinder_add(vertices=9, radius=7.0, depth=2.6,
                                    location=(-7.5, 10.5, 4.6))
mesa = bpy.context.view_layer.objects.active
mesa.name = "MesaLeft"
mesa.scale = (1.35, 1.0, 1.0)
mesa.data.materials.append(mesa_mat)
jitter(mesa, 0.35)
shade_smooth(mesa)
bpy.ops.mesh.primitive_cylinder_add(vertices=9, radius=6.4, depth=0.5,
                                    location=(-7.5, 10.5, 6.0))
mesa_top = bpy.context.view_layer.objects.active
mesa_top.name = "MesaTop"
mesa_top.scale = (1.35, 1.0, 1.0)
mesa_top.data.materials.append(sand_mat)

# Distant blue mountain spires (hazy silhouettes)
for i, (mx, my, mh, mr) in enumerate([
        (14, 42, 16, 7), (24, 46, 20, 9), (4, 48, 13, 6),
        (-8, 44, 15, 7), (32, 40, 12, 5), (-22, 38, 12, 6)]):
    bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=mr, depth=mh,
                                    location=(mx, my, mh * 0.5 - 1))
    m = bpy.context.view_layer.objects.active
    m.name = f"Spire{i}"
    m.data.materials.append(mount_mat)
    jitter(m, 1.1)

# Floating flat-topped rocks (ref: levitating slabs right background)
for i, (fx, fy, fz, fr) in enumerate([(5.0, 13, 7.0, 2.0), (7.5, 17, 9.0, 1.4),
                                       (4.0, 21, 10.5, 1.0)]):
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=fr, depth=fr * 0.45,
                                        location=(fx, fy, fz))
    f = bpy.context.view_layer.objects.active
    f.name = f"Floater{i}"
    f.data.materials.append(float_mat)
    jitter(f, 0.18)
    shade_smooth(f)

# --------------------------------------------------------------------------
# Creature: guanaco/vicuna-like proxy (head/eye focus, wrinkled neck, body)
# --------------------------------------------------------------------------
HEAD = (-0.45, 0.15, 1.62)  # head center (left-center foreground)

# Shoulder/body mass (rust-orange, mostly out of frame bottom-right like ref)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.85, location=(0.85, 0.85, 0.30))
body = bpy.context.view_layer.objects.active
body.name = "Body"
body.scale = (1.1, 0.9, 0.8)
body.data.materials.append(fur_rust)
shade_smooth(body)

# Long neck: tapered, wrinkled (vertex rings), leaning forward-left
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.30, depth=1.5,
                                    location=(0.12, 0.45, 0.95))
neck = bpy.context.view_layer.objects.active
neck.name = "Neck"
neck.rotation_euler = (math.radians(-18), 0, math.radians(-12))
neck.data.materials.append(fur_tan)
# taper top + wrinkle rings
for v in neck.data.vertices:
    t = (v.co.z + 0.75) / 1.5  # 0 bottom .. 1 top
    s = 1.0 - t * 0.45
    wr = 1.0 + 0.055 * math.sin(t * 28.0)  # throat/neck folds
    v.co.x *= s * wr
    v.co.y *= s * wr
neck.data.update()
shade_smooth(neck)

# Throat dewlap folds: flattened, tucked into the neck surface, single fur tone
for i in range(4):
    z = 0.75 + i * 0.22
    x = 0.06 - i * 0.05
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.20 - i * 0.015,
                                         location=(x, 0.33 - i * 0.035, z))
    d = bpy.context.view_layer.objects.active
    d.name = f"Dewlap{i}"
    d.scale = (1.05, 0.7, 0.40)
    d.data.materials.append(fur_tan)
    shade_smooth(d)

# Cranium
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.30, location=HEAD)
head = bpy.context.view_layer.objects.active
head.name = "Head"
head.scale = (1.0, 1.05, 1.1)
head.data.materials.append(fur_tan)
shade_smooth(head)

# Snout: SHORT rounded 3/4-front muzzle pointing forward-left toward the
# camera (-X, -Y, slightly down), like the v2 framing / ref. Length ~0.47
# (base->tip), NOT the v3 0.85 side-profile tube (Ry 77deg removed; the axis
# is aimed with look_at instead of a fixed side rotation).
SNOUT_BASE = (-0.58, -0.02, 1.52)
SNOUT_TIP = (-0.92, -0.30, 1.36)
SNOUT_C = (-0.75, -0.16, 1.44)
bpy.ops.mesh.primitive_cylinder_add(vertices=14, radius=0.17, depth=0.50,
                                    location=SNOUT_C)
snout = bpy.context.view_layer.objects.active
snout.name = "Snout"
look_at(snout, SNOUT_TIP)  # local -Z (tapered end) -> toward the nose tip
# taper: shrink nose end for a rounded snout; slight fullness at head end
for v in snout.data.vertices:
    if v.co.z < 0:
        v.co.x *= 0.72
        v.co.y *= 0.72
    elif v.co.z > 0.15:
        v.co.x *= 1.03
        v.co.y *= 1.03
snout.data.update()
snout.data.materials.append(fur_tan)
shade_smooth(snout)

# Nose bridge: short defining ridge from forehead to the snout base top
bpy.ops.mesh.primitive_cube_add(size=0.3, location=(-0.58, -0.02, 1.60))
bridge = bpy.context.view_layer.objects.active
bridge.name = "NoseBridge"
bridge.scale = (1.0, 0.45, 0.28)
bridge.rotation_euler = (0, math.radians(-8), math.radians(40))
bridge.data.materials.append(fur_tan)
_bv0 = bridge.modifiers.new("Soften", "BEVEL")
_bv0.width = 0.03
_bv0.segments = 2

# Cream blaze: thin strip down the muzzle top-center (ref signature marking)
bpy.ops.mesh.primitive_cube_add(size=0.2, location=(-0.75, -0.16, 1.585))
blaze = bpy.context.view_layer.objects.active
blaze.name = "MuzzleBlaze"
blaze.scale = (1.8, 0.30, 0.08)
blaze.rotation_euler = (0, math.radians(-8), math.radians(40))
blaze.data.materials.append(fur_cream)
_bv1 = blaze.modifiers.new("Soften", "BEVEL")
_bv1.width = 0.008
_bv1.segments = 2

# Muzzle creases: thin fur-tone rings hugging the short snout (crease
# shadows only — never dark bars). Fractions along base->tip axis.
_SNOUT_AX = (SNOUT_TIP[0] - SNOUT_BASE[0], SNOUT_TIP[1] - SNOUT_BASE[1],
             SNOUT_TIP[2] - SNOUT_BASE[2])
for wi, (wf, wr) in enumerate([(0.30, 0.150), (0.55, 0.140), (0.78, 0.128)]):
    _wc = (SNOUT_BASE[0] + _SNOUT_AX[0] * wf,
           SNOUT_BASE[1] + _SNOUT_AX[1] * wf,
           SNOUT_BASE[2] + _SNOUT_AX[2] * wf)
    bpy.ops.mesh.primitive_torus_add(major_radius=wr, minor_radius=0.006,
                                     location=_wc)
    w = bpy.context.view_layer.objects.active
    w.name = f"Wrinkle{wi}"
    look_at(w, SNOUT_TIP)
    w.data.materials.append(fur_tan)

# Nose tip (leather) at the front of the short muzzle, facing the camera
# (-Y) + nostrils: small symmetric rims + cavities on the front face,
# short philtrum groove tucked below.
_NOSE_C = (-0.945, -0.325, 1.35)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.095, location=_NOSE_C)
nose = bpy.context.view_layer.objects.active
nose.name = "Nose"
nose.scale = (1.0, 0.9, 0.85)
nose.data.materials.append(nose_mat)
shade_smooth(nose)
for i, _sx in enumerate([-1, 1]):
    _nx, _ny, _nz = _NOSE_C[0] + _sx * 0.036, _NOSE_C[1] - 0.055, _NOSE_C[2] + 0.012
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.028, location=(_nx, _ny, _nz))
    rim = bpy.context.view_layer.objects.active
    rim.name = f"NostrilRim{i}"
    rim.scale = (1.0, 0.8, 1.2)
    rim.data.materials.append(nose_mat)
    shade_smooth(rim)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.016, location=(_nx, _ny - 0.012, _nz))
    n = bpy.context.view_layer.objects.active
    n.name = f"Nostril{i}"
    n.scale = (0.9, 0.7, 1.2)
    n.data.materials.append(nostril_mat)
    shade_smooth(n)
# philtrum groove: short thin tuck directly under the nose
bpy.ops.mesh.primitive_cube_add(size=0.2, location=(_NOSE_C[0], _NOSE_C[1] + 0.01,
                                                   _NOSE_C[2] - 0.095))
philt = bpy.context.view_layer.objects.active
philt.name = "Philtrum"
philt.scale = (0.12, 0.08, 0.30)
philt.data.materials.append(mouth_mat)
_phb = philt.modifiers.new("Soften", "BEVEL")
_phb.width = 0.008
_phb.segments = 2

# Lower jaw: rounded, furred, tucked directly under the short muzzle
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.15, location=(-0.68, -0.10, 1.32))
jaw = bpy.context.view_layer.objects.active
jaw.name = "Jaw"
jaw.scale = (1.25, 0.9, 0.55)
jaw.data.materials.append(fur_tan)
shade_smooth(jaw)
# closed mouth: thin seam hugging the jaw top edge under the muzzle on the
# camera side (no floating bar); tiny upturn sliver at the rear corner only
bpy.ops.mesh.primitive_cube_add(size=0.2, location=(-0.72, -0.235, 1.345))
mouth = bpy.context.view_layer.objects.active
mouth.name = "MouthLine"
mouth.scale = (1.1, 0.10, 0.045)
mouth.rotation_euler = (0, 0, math.radians(40))
mouth.data.materials.append(mouth_mat)
bpy.ops.mesh.primitive_cube_add(size=0.2, location=(-0.52, -0.12, 1.38))
smile = bpy.context.view_layer.objects.active
smile.name = "SmileUpturn"
smile.scale = (0.45, 0.10, 0.05)
smile.rotation_euler = (math.radians(-15), 0, math.radians(55))
smile.data.materials.append(mouth_mat)
# lower lip + chin tucked under the muzzle
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(-0.70, -0.19, 1.29))
lip = bpy.context.view_layer.objects.active
lip.name = "LowerLip"
lip.scale = (0.16, 0.10, 0.05)
lip.data.materials.append(fur_tan)
shade_smooth(lip)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.08, location=(-0.58, -0.06, 1.24))
chin = bpy.context.view_layer.objects.active
chin.name = "Chin"
chin.scale = (1.1, 0.8, 0.7)
chin.data.materials.append(fur_cream)
shade_smooth(chin)
for ci in range(3):
    bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=0.016, depth=0.06,
                                    location=(-0.62 + ci * 0.05, -0.08, 1.18))
    ct = bpy.context.view_layer.objects.active
    ct.name = f"ChinTuft{ci}"
    ct.rotation_euler = (math.radians(170 + ci * 8), 0, 0)
    ct.data.materials.append(fur_cream)
# soften thin seam boxes (jaw/lip/chin are already smooth)
for _o in (mouth, smile, philt):
    _b = _o.modifiers.new("Soften", "BEVEL")
    _b.width = 0.008
    _b.segments = 2

# Cheek ruff (slim cream side blaze like ref)
for i, (cx, cy, cz, sx, sy, sz) in enumerate([
        (-0.50, -0.10, 1.52, 0.14, 0.08, 0.22),
        (-0.58, -0.08, 1.40, 0.11, 0.07, 0.16)]):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.5, location=(cx, cy, cz))
    c = bpy.context.view_layer.objects.active
    c.name = f"Cheek{i}"
    c.scale = (sx * 2, sy * 2, sz * 2)
    c.data.materials.append(fur_cream)
    shade_smooth(c)

# Ears: tall upright, slightly out-turned, both fully visible above the crown
EAR_SPECS = [(-0.52, 0.16, 2.02, -0.35), (-0.16, 0.16, 2.00, 0.40)]
for i, (ex, ey, ez, tilt) in enumerate(EAR_SPECS):
    bpy.ops.mesh.primitive_cone_add(vertices=10, radius1=0.11, depth=0.42,
                                    location=(ex, ey, ez))
    e = bpy.context.view_layer.objects.active
    e.name = f"Ear{i}"
    e.rotation_euler = (math.radians(-10), 0, tilt)
    e.data.materials.append(fur_tan)
    shade_smooth(e)
    # inner ear (pink-cream cup, camera side)
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.055, depth=0.30,
                                    location=(ex, ey - 0.035, ez - 0.02))
    inn = bpy.context.view_layer.objects.active
    inn.name = f"EarInner{i}"
    inn.rotation_euler = (math.radians(-10), 0, tilt)
    inn.data.materials.append(fur_cream)
    # rim fuzz: short pale tufts along the outer rim
    for fi in range(3):
        fx = ex + (fi - 1) * 0.055
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=0.012, depth=0.055,
                                        location=(fx, ey, ez + 0.20 - abs(fi - 1) * 0.03))
        fh = bpy.context.view_layer.objects.active
        fh.name = f"EarFuzz{i}_{fi}"
        fh.rotation_euler = (math.radians(-8), 0, tilt * 0.5)
        fh.data.materials.append(fur_cream)

# Eyes: dark glossy orb + amber iris + pupil + clearcoat cornea bulge.
# The hero highlight comes from the real sun specular; the emissive bead is
# kept only as a tiny dim fill (v1's 6.0-strength bead looked fake).
EYE_L = (-0.52, -0.22, 1.70)  # camera-side hero eye
EYE_R = (-0.28, 0.42, 1.70)
_CAM = mathutils.Vector((-2.7, -5.4, 2.15))
for nm, pos, r in [("EyeNear", EYE_L, 0.15), ("EyeFar", EYE_R, 0.11)]:
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=pos)
    e = bpy.context.view_layer.objects.active
    e.name = nm
    e.scale = (1.0, 0.72, 1.12)
    e.data.materials.append(eye_mat)
    shade_smooth(e)
    # cornea bulge: clearcoat transmissive shell, slightly proud of the orb
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r * 1.06, location=pos)
    co = bpy.context.view_layer.objects.active
    co.name = nm + "Cornea"
    co.scale = (1.0, 0.75, 1.12)
    co.data.materials.append(cornea_mat)
    shade_smooth(co)

# hero iris + pupil on the camera-facing side of the near eye
_iris_dir = (_CAM - mathutils.Vector(EYE_L)).normalized()
_iris_c = mathutils.Vector(EYE_L) + _iris_dir * 0.112
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.075, location=_iris_c)
iris = bpy.context.view_layer.objects.active
iris.name = "IrisNear"
iris.scale = (1.0, 1.0, 1.0)
look_at(iris, _CAM)
iris.scale = (1.0, 1.0, 0.45)
iris.data.materials.append(iris_mat)
shade_smooth(iris)
_pup_c = _iris_c + _iris_dir * 0.026
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.036, location=_pup_c)
pup = bpy.context.view_layer.objects.active
pup.name = "PupilNear"
look_at(pup, _CAM)
pup.scale = (1.0, 1.0, 0.5)
pup.data.materials.append(pupil_mat)
shade_smooth(pup)
# strong sun catchlight fill, upper-left of the iris
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.013, location=(EYE_L[0] - 0.035,
                                                             EYE_L[1] - 0.075,
                                                             EYE_L[2] + 0.09))
cl = bpy.context.view_layer.objects.active
cl.name = "Catchlight"
cl.data.materials.append(catch_mat)
# thin natural lids hugging the large orb (no torus rings — v3's LashLine /
# LidFold tori read as heavy white circles, so they are gone)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.15, location=(EYE_L[0] + 0.03,
                                                             EYE_L[1] + 0.04,
                                                             EYE_L[2] + 0.13))
lid = bpy.context.view_layer.objects.active
lid.name = "Eyelid"
lid.scale = (1.05, 0.80, 0.45)
lid.data.materials.append(fur_tan)
shade_smooth(lid)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.13, location=(EYE_L[0] + 0.02,
                                                              EYE_L[1] - 0.01,
                                                              EYE_L[2] - 0.125))
lid_lo = bpy.context.view_layer.objects.active
lid_lo.name = "EyelidLower"
lid_lo.scale = (1.0, 0.75, 0.35)
lid_lo.data.materials.append(fur_tan)
shade_smooth(lid_lo)
# dark limbal ring around the iris edge
bpy.ops.mesh.primitive_torus_add(major_radius=0.068, minor_radius=0.007,
                                 location=_iris_c)
limbus = bpy.context.view_layer.objects.active
limbus.name = "LimbusNear"
look_at(limbus, _CAM)
limbus.data.materials.append(pupil_mat)
# tear duct / moist caruncle at the inner (snout-side) eye corner
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.024,
                                     location=(EYE_L[0] - 0.135, EYE_L[1] - 0.01,
                                               EYE_L[2] - 0.01))
tear = bpy.context.view_layer.objects.active
tear.name = "TearDuct"
tear.data.materials.append(caruncle_mat)
shade_smooth(tear)
# eyelash fringe: short dark cones along the upper lash arc
_f = (_CAM - mathutils.Vector(EYE_L)).normalized()
_upv = mathutils.Vector((0, 0, 1))
_rv = _f.cross(_upv).normalized()
_uv2 = _rv.cross(_f).normalized()
for _li in range(12):
    _a = math.radians(25 + _li * (130.0 / 11))
    _dir = (_rv * math.cos(_a) + _uv2 * math.sin(_a)).normalized()
    _lp = mathutils.Vector(EYE_L) + _dir * 0.148
    bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=0.005, depth=0.030,
                                    location=_lp + _dir * 0.012)
    _lh = bpy.context.view_layer.objects.active
    _lh.name = f"Lash{_li}"
    _q = mathutils.Vector((0, 0, 1)).rotation_difference(_dir)
    _lh.rotation_mode = "QUATERNION"
    _lh.rotation_quaternion = _q
    _lh.data.materials.append(mouth_mat)

focus_empty.location = EYE_L  # tack-sharp eye

# --- Fur: real particle guard-hair + neck mane (replaces v1 spike cones) ---
def add_guard_hair(obj, name, count, length, seed=0, clump=0.4,
                   kink_amp=0.12, child_render=6, child_simple=False):
    """Short combed guard hairs with kink/clump + interpolated children."""
    try:
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception:
        pass
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.particle_system_add()
    except Exception as e:
        print("particle_system_add failed for", obj.name, e)
        return False
    try:
        psys = obj.particle_systems.active
    except Exception as e:
        print("no active particle system for", obj.name, e)
        return False
    psys.name = name
    s = psys.settings
    PSET(s, "type", "HAIR")
    PSET(s, "count", count)
    PSET(s, "seed", seed)
    PSET(s, "hair_step", 3)
    PSET(s, "render_step", 3)
    PSET(s, "display_step", 2)
    PSET(s, "hair_length", length)
    PSET(s, "length_random", 0.45)
    PSET(s, "emit_from", "FACE")
    PSET(s, "distribution", "JITTERED")
    PSET(s, "jitter_factor", 0.6)
    PSET(s, "use_hair_dynamics", False)
    # kink + clump: natural wave instead of straight spikes
    PSET(s, "kink", "CURL")
    PSET(s, "kink_amplitude", kink_amp)
    PSET(s, "kink_frequency", 2.0)
    PSET(s, "kink_shape", 0.5)
    PSET(s, "clump_factor", clump)
    PSET(s, "clump_shape", 0.8)
    PSET(s, "roughness_1", 0.35)
    PSET(s, "roughness_2", 0.15)
    # children: dense undercoat without the strand cost
    PSET(s, "child_type", "SIMPLE" if child_simple else "INTERPOLATED")
    PSET(s, "rendered_child_count", child_render)
    PSET(s, "child_nbr", 2)
    PSET(s, "child_length", 0.9)
    PSET(s, "child_radius", 0.05)
    try:
        if obj.data.materials:
            PSET(s, "material", 1)
    except Exception:
        pass
    return True


_ok_head = add_guard_hair(head, "GuardHead", count=700, length=0.030, seed=3,
                          clump=0.35, kink_amp=0.06, child_render=8)
# short groomed facial fur on the muzzle (~1/4 of neck length, never shaggy)
_ok_snout = add_guard_hair(snout, "GuardSnout", count=350, length=0.018, seed=11,
                           clump=0.30, kink_amp=0.05, child_render=4)
_ok_neck = add_guard_hair(neck, "GuardNeck", count=900, length=0.08, seed=5,
                          clump=0.45, kink_amp=0.10, child_render=6)
_ok_body = add_guard_hair(body, "GuardBody", count=600, length=0.08, seed=9,
                          clump=0.4, kink_amp=0.10, child_render=4)
print("particle hair: head=%s snout=%s neck=%s body=%s" % (_ok_head, _ok_snout, _ok_neck, _ok_body))

# Combed fuzz backup: short FLAT-lying clumps combed down-back (never radial
# spikes), so fur reads even where particle strands are sparse in stills.
import mathutils as _mu
_COMB = _mu.Vector((0.30, 0.30, -0.9)).normalized()
_HC = _mu.Vector(HEAD)
placed = 0
tries = 0
while placed < 220 and tries < 1500:
    tries += 1
    th = RNG.uniform(0, 6.283)
    ph = RNG.uniform(-0.25, 1.35)
    d = _mu.Vector((math.cos(th) * math.cos(ph), math.sin(th) * math.cos(ph) * 0.9,
                    math.sin(ph)))
    if d.z < 0.05 and RNG.random() < 0.8:
        continue
    surf = _HC + d * 0.30
    if math.hypot(surf.x - EYE_L[0], surf.y - EYE_L[1], surf.z - EYE_L[2]) < 0.23:
        continue  # keep the eye + lids clear
    if math.hypot(surf.x - SNOUT_TIP[0], surf.y - SNOUT_TIP[1],
                  surf.z - SNOUT_TIP[2]) < 0.20:
        continue  # keep the nose leather clear
    if surf.x < -0.55 and surf.y < 0.12 and surf.z > 1.45:
        continue  # keep muzzle blaze + bridge groomed, not shaggy
    if surf.z < 1.30:  # keep off the muzzle
        continue
    # comb flat: mostly tangent (down-back), slight lift off the surface
    tang = (_COMB - d * _COMB.dot(d))
    if tang.length < 1e-4:
        tang = _mu.Vector((0, 0, -1))
    tang.normalize()
    orient = (tang * 0.85 + d * 0.35).normalized()
    bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=0.016,
                                    depth=RNG.uniform(0.030, 0.055),
                                    location=surf + d * 0.004)
    h = bpy.context.view_layer.objects.active
    h.name = f"Fuzz{placed}"
    q = _mu.Vector((0, 0, 1)).rotation_difference(orient)
    h.rotation_mode = "QUATERNION"
    h.rotation_quaternion = q
    # squash across the lie direction -> flat clump, not a spike
    h.scale.x = 0.55
    h.data.materials.append(fur_cream if RNG.random() < 0.4 else fur_tan)
    placed += 1

# --------------------------------------------------------------------------
# Wooden pack-frame on back (planks + crossbar + rope + tribal paint)
# --------------------------------------------------------------------------
PACK_C = (0.55, 0.55, 1.55)
# dark backing board so the slots between planks read as deep AO gaps
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(PACK_C[0], PACK_C[1] + 0.06,
                                                    PACK_C[2] - 0.05))
backing = bpy.context.view_layer.objects.active
backing.name = "PlankBacking"
backing.scale = (0.42, 0.05, 0.72)
backing.rotation_euler = (0, math.radians(3), 0)
backing.data.materials.append(gap_mat)
# 4 weathered vertical planks with real slots between them, slight fan/tilt
for i in range(4):
    px = PACK_C[0] - 0.30 + i * 0.20
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(px, PACK_C[1], PACK_C[2]))
    p = bpy.context.view_layer.objects.active
    p.name = f"Plank{i}"
    p.scale = (0.085, 0.16, 0.62)
    p.rotation_euler = (math.radians(RNG.uniform(-4, 4)),
                        math.radians(RNG.uniform(-7, 7)),
                        math.radians(RNG.uniform(-3, 3)))
    p.data.materials.append(wood_mat)
    jitter(p, 0.012)  # weathered edges
    _bv = p.modifiers.new("EdgeWear", "BEVEL")
    _bv.width = 0.015
    _bv.segments = 2
# crossbar cylinder through planks
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.085, depth=1.05,
                                    location=(PACK_C[0], PACK_C[1] - 0.05,
                                              PACK_C[2] + 0.10))
bar = bpy.context.view_layer.objects.active
bar.name = "Crossbar"
bar.rotation_euler = (math.radians(90), math.radians(4), math.radians(90))
bar.data.materials.append(wood_mat)
jitter(bar, 0.01)
_bv = bar.modifiers.new("EdgeWear", "BEVEL")
_bv.width = 0.012
_bv.segments = 2
shade_smooth(bar)
# rope binding: two flat wraps hugging the plank cluster horizontally
for i, rz in enumerate([PACK_C[2] + 0.10, PACK_C[2] - 0.28]):
    bpy.ops.mesh.primitive_torus_add(major_radius=0.40, minor_radius=0.032,
                                     location=(PACK_C[0], PACK_C[1] - 0.02, rz))
    r = bpy.context.view_layer.objects.active
    r.name = f"Rope{i}"
    r.rotation_euler = (0, 0, 0)
    r.scale = (0.92, 0.34, 1.0)
    r.data.materials.append(rope_mat)
# strap from pack to neck
bpy.ops.mesh.primitive_cube_add(size=0.5, location=(0.18, 0.45, 1.35))
strap = bpy.context.view_layer.objects.active
strap.name = "Strap"
strap.scale = (0.5, 0.08, 0.1)
strap.rotation_euler = (0, math.radians(-18), math.radians(-12))
strap.data.materials.append(rope_mat)
# tribal circle decal plane, facing the camera (-Y), just off the front planks
bpy.ops.mesh.primitive_plane_add(size=0.55, location=(PACK_C[0] - 0.05,
                                                      PACK_C[1] - 0.20,
                                                      PACK_C[2] + 0.05))
decal_plane = bpy.context.view_layer.objects.active
decal_plane.name = "TribalPaint"
decal_plane.rotation_euler = (math.radians(90), 0, math.radians(-4))
decal_plane.data.materials.append(decal)

# --------------------------------------------------------------------------
# Render
# --------------------------------------------------------------------------
print(f"Objects: {len(bpy.data.objects)} | Rendering {OUT_PATH} ...")
bpy.ops.render.render(write_still=True)
dt_s = time.time() - T0
print(f"DONE render_photoreal.png in {dt_s:.1f}s -> {OUT_PATH}")
