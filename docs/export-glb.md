# Download the map as a 3D model (.glb)

On the search page, **Download 3D model (.glb)** (next to the slider legend) saves what you see as a binary glTF 2.0 file, readable by Blender, Sketchfab, three.js,
`<model-viewer>`, phone AR viewers and the Windows 3D viewer. The button is enabled when the map is complete ("Map from N papers"), there is at least one paper and the viewer has loaded the brain.
File name: `brainspell-<query as letters-digits-hyphens, at most 40>-<N>papers.glb`. The file is made in the browser; nothing is sent to the server.

## What is in the file

| node | what | material |
|---|---|---|
| `level_25` | surface of the map at 25% of the strongest region | unlit light red, alpha 0.22 (BLEND) |
| `level_50`, `level_50_outline` | the same at 50% (the default slider level) and its black outline | unlit red, opaque; outline = the surface pushed out by 0.03 viewer units (6% of a voxel) with reversed winding, black, single-sided (an "inverted hull") |
| `level_75`, `level_75_outline` | the same at 75% | unlit darker red, opaque |
| `brain` | the translucent brain exactly as the live viewer holds it (the viewer's own geometry, not reloaded) | unlit blue-grey (196, 202, 212), material alpha 0.4 (BLEND), double-sided, times a vertex alpha of 0.5 (surfaces facing the top and front) to 1 (grazing angles): 0.2 to 0.4 in spec-compliant viewers, a uniform 0.4 in viewers that ignore vertex alpha |

The brain is the LAST node on purpose (viewers that write depth for transparent surfaces, such as three.js, would otherwise hide `level_25` behind it).
Levels are computed exactly as on screen: a fraction of the strongest peak count, on the same smoothed volume, with the viewer's own surface-nets
(`node_modules/translucent-viewer/surfacenets.js`). A level with no surface (a very flat map) is left out. Asset `extras` (and the scene's) hold: the query, papers used and
matching, the slider level, the three fractions, the creation date, the alignment note and the data source. The file makes **no licence claim**: `LICENSE_TEXT` in
`client/annotation/glb.js` is empty; when it is not, it is written to `asset.copyright`.

## Colours and alpha (tuned in current viewers)

Spec-compliant viewers (current three.js, `<model-viewer>`, Blender, Sketchfab) multiply the vertex alpha with the material alpha and treat COLOR_0 as LINEAR:
the colours chosen for the screen (sRGB) are therefore converted to linear before they are written (`srgbToLinearColors`), so the reds appear as red, not salmon.
Old three.js (r119) ignores vertex alpha and shows the linear numbers as they are (a darker red): acceptable fallback. Reference renders: `glb-viewer-modern.html`
(three.js r160), `glb-viewer-mv.html` (`<model-viewer>` 3.5.0) and `glb-viewer.html` (r119).

## Units, orientation, alignment

glTF is Y-up, the front faces +Z, units are metres. Viewer space (x right, y anterior = up in the top-down page view, z superior; 1 viewer unit = 1/0.14 mm of the
brain) is mapped by `(x, y, z) -> (-x, z, y) * 0.001/0.14` (a rotation, no mirroring): anterior -> +Z, superior -> +Y, the subject's right -> -X (seen from the front it is on
the viewer's left). A 170 mm brain is about 0.17 m long. The exported model of "cognition" is 0.132 x 0.121 x 0.168 m. Blobs sit on the brain exactly as on screen;
that alignment is the website's own and is approximate (a surface voxel is 4 mm in the data but 0.5 viewer units = 3.6 mm on screen), **not for quantitative use**.

## What is approximated

The website draws the brain with a view-dependent GLOW shader and the map with a view-dependent TOON shader (custom shaders: glTF cannot hold them). So:
the glow is replaced by a fixed alpha plus a vertex alpha rim computed for the top and front views; the toon bands (centre = red, then darker bands, black rim) are
baked into vertex colours for a view from above and slightly the front (`VIEW_DIR`). From other directions the bands do not follow the camera. The geometry is exact.

## Opening it

* **Blender**: File > Import > glTF 2.0. Materials come in as emission (unlit); set the viewport to Material Preview.
* **Sketchfab**: upload the .glb; set the shading to "shadeless" if the colours look dark.
* **three.js**: `GLTFLoader`; **model-viewer**: `<model-viewer src="file.glb" camera-controls>`; phones: open the file in the system viewer / AR Quick Look via model-viewer.
* Transparency order differs between viewers; if a shell hides another, turn the brain or `level_25` off.

## Checks and tools

`client/test/glb.test.js` (writer, orientation, levels, outlines, baked bands, file name, empty map), `client/test/tools/glb-validate.mjs <file>` (Khronos glTF-Validator),
`client/test/tools/glb-render.mjs` + `glb-viewer*.html` (renders a model with three.js r119, r160 or model-viewer from front/top/side/angled), and the smoke tool (button enabled, a click downloads a valid GLB).
Sizes: "cognition" (445 papers) 0.45 MB, "working memory" (1753 papers) 0.40 MB: no decimation is needed.
