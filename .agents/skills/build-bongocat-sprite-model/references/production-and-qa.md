# Sprite Production And QA

## Canonical-First Rule

Choose one approved transparent RGBA frame as canonical. It owns:

- character position and scale
- face, hair, costume, prop, and body geometry
- all static colors and textures
- the alpha silhouette
- transparent padding
- every permanent attached element and its depth relationship to the body and prop

Never average several AI frames into the canonical source. Never independently fit, center, color-match, or scale each final timeline frame. Native donor patches may need rigid registration against a fixed shoulder or forehead anchor before local extraction; keep the source family's scale shared and never turn donor registration into per-frame whole-character fitting.

Do not split a visually integrated character into a base sheet plus a separately generated permanent overlay. Ribbons, tails, wings, ornaments, back pieces, and similar elements must share the canonical material, lighting, position, and occlusion in every frame. A reference image approved as a character template does not make its background, composition, or temporary effect part of the model.

## Image Generation Prompts

Keep prompts concise and attach the canonical/reference images.

Canonical prompt requirements:

```text
Create one polished Q-style desktop-pet character on a transparent background. Preserve the referenced identity, face, hair, costume, palette, and signature prop. Show the complete seated character and complete prop, centered with generous transparent padding. No text, scenery, floor, shadow, extra object, blur, glow, or cropped part.
```

Action donor requirements:

```text
Edit the canonical desktop-pet character into one clear action key pose. Move both hands and only the minimum connected sleeve area needed for the gesture. Preserve face, hair, torso, costume, prop geometry, camera, scale, position, lighting, palette, and transparent background. No motion blur, afterimage, text, detached effect, or extra limb.
```

Transformation reference requirements:

```text
Edit the canonical desktop-pet character into the requested transformed appearance. Preserve pose, position, proportions, face, hands, prop, camera, and silhouette. Change only the requested color treatment and attached or external effect. Transparent background; no scenery, text, blur, crop, or unrelated geometry change.
```

Treat these outputs as donors. Deterministic compositing owns final consistency.

A generated multi-frame strip is never a production timeline merely because its grid and poses look plausible. Whole-frame stabilization can reduce bounding-box jitter but cannot remove frame-to-frame redraw of line art, facial proportions, texture, or material. Extract only approved local pose, expression, or effect donors and rebuild the final timeline from the immutable canonical.

## Idle Recipe

1. Select one canonical open-eye frame.
2. Create one crisp closed-eye donor.
3. Define independent left and right eye masks with a small feather.
4. Build the blink sequence by copying the canonical frame and replacing only pixels inside those masks.
5. Use frame durations to hold the calm state instead of duplicating many near-identical generated frames.

Acceptance:

- each eye changes by a non-zero amount
- outside-eye maximum RGBA delta equals zero
- hands, prop, torso, hair, and alpha geometry equal canonical
- no half-open opacity blend, gray iris, or double eyelid

## Expression And Mouth Recipe

Define separate ROIs for eyes, brows, cheeks, and lips when the action requires emotion or speech. These ROIs are allowed to change; the rest of the face is not.

1. Keep head position, face outline, hairline, skin lighting, and feature proportions canonical.
2. Build blink, smile, surprise, pout, and mouth-open states as small deterministic layers or locally clipped donors.
3. Use real intermediate mouth/eye states when a change is large enough to pop at normal display size.
4. Never replace the entire face or head to obtain one expression, and never let a mouth donor alter nose, jaw, earrings, hair, or costume.

Acceptance:

- all pixels outside declared expression ROIs equal canonical within the protected head region
- eyes and lips change only when required by the action semantics
- normal awake idle remains open-eyed; closed eyes are reserved for blink, sleep, or an intentional expression
- no feature-size drift, face-shape breathing, skin-tone flash, or lip position jump

## Whole-Arm, Finger-Led Action Recipe

Use the approved character and the gesture's phrasing to choose native key poses. For instrument playing, the forearm guides the wrist while thumb/index/middle fingers hook, flick, and recover at different phases. Preserve expressive connected arm motion; a fixed arm with a moving wrist is not an equivalent repair.

A simple gesture may use a symmetric layout:

```text
0 canonical
1 intermediate
2 peak
3 peak
4 intermediate
5 canonical
```

Use real intermediate donors where the motion needs them. A finger-led pluck may use a non-symmetric sequence with several distinct finger shapes. Frame count alone is not smoothness: inspect adjacent poses at actual durations and normal display size.

For every action:

1. Define left-hand and right-hand skin/sleeve corridors as character-specific polygons or masks.
2. Expand the donor/canonical skin and sleeve difference slightly, feather the edge by about 1–2 pixels, then clip it to the correct corridor.
3. Erase the canonical hand only within that same local corridor and composite the donor patch.
4. Keep the instrument and all protected regions canonical unless a minimal occlusion repair is unavoidable.
5. Compose both sides from immutable single-hand or native two-hand donors. Never use a previously composed output as a new donor.

Do not crop companion hands at `canvasWidth / 2`. A hand or sleeve may cross the centerline. Measure independent left/right action corridors and require motion in each exclusive core.

Acceptance:

- first and last frames equal canonical exactly
- mirrored frames match exactly only when the selected recipe is symmetric
- finger shape changes independently of palm position when the gesture calls for articulation
- five-finger anatomy, full palms, and connected wrists hold throughout the gesture, including the resting companion hand
- every hand intended to move has distinct poses in its exclusive core; an intentionally resting companion hand retains its full canonical palm
- action-corridor exterior delta equals zero
- protected face geometry outside declared expression ROIs has zero delta
- no duplicate hand, broken finger, ghost sleeve, seam, or prop texture jump

## Transformation Recipe

Prefer a 16-frame symmetric envelope:

```text
progress = [0, .055, .198, .394, .606, .802, .945, 1,
            1, .945, .802, .606, .394, .198, .055, 0]
```

Interpolate canonical colors toward one deterministic transformed target. Apply the same transformation to the same source RGB values within each frame. Fade approved external effects with the same or a separately specified symmetric envelope.

Suggested durations:

```text
[70, 60, 60, 60, 60, 60, 70, 180,
 180, 70, 60, 60, 60, 60, 60, 90]
```

Acceptance:

- frame 0 and final frame equal canonical exactly
- all symmetric frame pairs equal exactly
- two peak frames equal exactly
- character alpha equals canonical in every frame
- whitening or other scalar effect is monotonic into and out of the peak
- external effects never touch the cell edge
- no isolated fragments, residual fade patches, or geometry drift

## Lossless Sheet Assembly

Use Pillow or another deterministic RGBA pipeline. For a sheet with `frames`, `columns`, `frameWidth`, and `frameHeight`:

```text
rows = ceil(frames / columns)
sheetWidth = columns * frameWidth
sheetHeight = rows * frameHeight
cellX = (index % columns) * frameWidth
cellY = floor(index / columns) * frameHeight
```

Write fully transparent unused cells. Clear RGB to zero wherever alpha is zero. Save WebP losslessly with exact transparent RGB preservation when the encoder supports it.

Do not resize the composed sheet. Use a shared source scale before assembly. Where native donors drift, record only the rigid translation needed to register a fixed anatomical anchor before extracting the local patch. Do not scale individual poses by their changing silhouette or recenter final frames.

If generation used a neutral segmentation background, treat it only as a production aid. Recover real alpha, clear hidden RGB, and inspect the result on both dark and light backgrounds. A checkerboard painted into RGB is not transparency. Background removal must preserve fine permanent elements and reject grid-boundary fragments without deleting legitimate ribbons or effects.

## Repository Tools

`scripts/validate_sprite_sheet.py` provides a preliminary per-sheet check and creates a contact sheet plus GIF:

```bash
"$PYTHON" scripts/validate_sprite_sheet.py \
  --sheet "$SHEET" \
  --frames "$FRAMES" \
  --columns "$COLUMNS" \
  --report "$QA_DIR/report.json" \
  --contact-sheet "$QA_DIR/contact.png" \
  --preview "$QA_DIR/preview.gif"
```

The script infers cell dimensions from the sheet instead of accepting configured `frameWidth` and `frameHeight`. Before running it, independently require exact width `columns × frameWidth`, exact height `ceil(frames / columns) × frameHeight`, RGBA decoding, and cleared hidden RGB. Its GIF uses a fixed preview duration, so also produce a preview using the actual `frameDurations`. Do not use this script alone as the configuration-grid gate.

`scripts/stabilize_sprite_sheet.py` is a proven design reference but is not generic. Its eye boxes, `pluck-*` name checks, action polygons, donor graph, protected face region, two-hand corridors, color targets, effect extraction, and numeric thresholds are character-specific. With `--two-hand`, it currently selects the raw idle frame 0 as canonical instead of the stabilized canonical. Its companion and donor composition also truncates patches at `width // 2`. Replace both behaviors before using it for a new model, and adapt its checks if action names do not start with `pluck-`.

## Quantitative QA

At minimum, record these values per animation:

- decoded sheet size and expected size
- frame alpha bounding boxes and margins
- edge alpha pixel count
- hidden RGB maximum where alpha is zero
- first/last canonical maximum delta
- symmetric-pair maximum delta
- protected-region maximum delta
- expression-ROI and protected-face-exterior delta
- static-region RGBA maximum delta and MAE
- changed-pixel count inside each intended action core
- full-frame luminance and warm/cool drift
- alpha centroid spread
- unique frame count and active pose count

Use zero as the target for exact invariants. Treat aggregate full-character color drift carefully: intended hand or effect changes may move a global mean slightly, but any change in a declared static region is a failure.

## Visual QA

For each animation create:

- labeled contact sheet on a checkerboard
- real-duration GIF
- motion-difference image against canonical
- optionally a side-by-side original/stabilized GIF

Inspect every artifact independently. Reject:

- texture crawling or water-like waves
- global hue or exposure flashes
- outline breathing, scale popping, or centroid jitter
- half-opacity double hands or eyes
- abrupt large-pose jumps without an intermediate
- broken fingers, duplicate sleeves, or patch seams
- face, hair, torso, instrument, or costume contamination
- effects that fragment, touch edges, or leave fade residue
- final-to-idle flash cuts
- permanent accessories appearing late, disappearing early, changing material, or crossing the wrong body/prop depth

Do not accept an animation only because its JSON report says `ok: true`.

## Full Model And Runtime QA

Validate configuration through the application's `sprite.validateModel()` path. Then load the model in the actual app and test:

1. Idle for at least two complete cycles.
2. Every animation once, then rapid alternating actions.
3. Four simultaneous or repeated bubble labels.
4. Return, Enter, and keypad Enter.
5. Window scale, portrait and landscape aspect ratios, DPR 1 and 2, and mirror mode.
6. The user's saved opacity, scale, and corner radius.

For macOS global keys, confirm Input Monitoring for the exact built `.app`. Ad-hoc rebuilds can change the code-directory hash and invalidate an older authorization even when the bundle path and identifier stay the same.

After packaging, compare SHA-256 of source and bundled `model.json`, cover, and every sprite sheet. Verify the running process executable is inside the new bundle rather than an older build or installed copy.

Build the hash list from the manifests, including module-local animation paths. A top-level file with the same basename does not prove the runtime-loaded `modules/<id>/sprites/` file was updated.

## Reproducibility

- Keep raw references immutable.
- Write generated and stabilized output to a new directory.
- Never create cyclic donor dependencies.
- Make preservation guards test fixed semantic regions, not self-derived motion unions.
- Reject a supposedly two-hand sequence when only one hand corridor changes.
- Rerun the pipeline on its declared raw inputs and compare decoded frame hashes before calling it reproducible.

## Coordinated Refresh And Cleanup

For an approved canonical replacement, inventory actual top-level and module-local animation paths first. Keep existing action ids, bindings, state effects, dialogue, and audio unless their behavior is explicitly changing. Rebuild every affected steady loop, gesture, form variant, and transition against the new baseline; keep sleep restrained and gestures semantically distinct. Compare idle/action handoffs and form-specific open/closed eyes on light and dark backgrounds before promotion.

Retain the current canonical, raw native donors, masks/recipe, referenced audio, and any original reference still required to reproduce approved effects. Determine unused package assets from manifest references plus authoring-script callers, not filenames or age. Replace package files only after full validation. Retire rejected work copies, duplicate outputs, and caches after the replacement is verified; prefer moving resolved obsolete directories to Trash, and report what was removed and how to recover it.

The 2026-10-01 Qingxiao flat-motion refresh is authored by `scripts/refresh_qingxiao_motion.py`. It reads immutable inputs from the selected model folder's `references/motion/` and writes all manifest-reachable sheets plus real-duration QA:

```bash
"$BONGOCAT_PYTHON" scripts/refresh_qingxiao_motion.py \
  --model-dir "$WORK_MODEL_DIR" --qa-dir "$QA_DIR"
```

Run it on a work copy, not the installed model. Its masks and registration belong to Qingxiao, not a generic character API. Older Qingxiao builders encode earlier geometry; do not chain them after this refresh. Preserve trigger/state/dialogue/audio configuration during artwork-only work, and verify source-form transitions plus all module-local material variants.
