import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glbPath, DEFAULT_AXIE_ID } from './axieCatalog.js';

/* =============================================================================
   A small live 3D Axie, rendered into a transparent floating canvas that sits
   on top of the Leaflet map at the player's real GPS position — the real-map
   equivalent of the stylized-3D-field view in the Claude artifact build.
   Reuses the pivot+lookAt facing fix worked out there (this asset's front is
   authored along local +Z, and THREE.Object3D.lookAt() points an object's
   back at its target, not its front — see axie-vibeathon-v5-notes.md).

   The camera here is fixed (not chasing, since the character never moves in
   its own tiny scene — only the map pans under it), so the character itself
   rotates in place to face whichever way you're actually walking.

   Each of the 5 selectable Axies has a different native size/proportions
   (Paladill's staff, Kibo's wings, ...) — a single fixed MODEL_SCALE tuned
   for one of them clips the others against this small square canvas. So
   after loading, every model is measured with a THREE.Box3 and rescaled +
   recentered to a consistent on-screen footprint (fitModelToFrame below),
   instead of trusting one hardcoded scale for every character.

   Which Axie is shown is now a user choice (see the picker sheet) instead of
   a hardcoded Kotaro — `setCharacter(id)` swaps the loaded model without
   tearing down the renderer/scene, so switching characters mid-app is cheap.
   ============================================================================= */

const CAM_POS = new THREE.Vector3(0, 2.05, 3.15);
const LOOK_AT = new THREE.Vector3(0, 0.85, 0);
const MESH_FACE_OFFSET = Math.PI; // this pack's front is authored along local +Z
const TARGET_HEIGHT = 1.85; // consistent on-screen height for every character
const TARGET_MAX_WIDTH = 1.55; // caps wide poses (staffs, wings) so they don't clip the frame edges
const UP_AXIS = new THREE.Vector3(0, 1, 0);

// Measures a loaded, already-rotated model and rescales + repositions it so
// it always fills the same on-screen footprint and always stands on the
// local ground plane (y = 0), regardless of that character's native size.
function fitModelToFrame(object) {
  object.scale.setScalar(1);
  object.position.set(0, 0, 0);
  object.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(object);
  const size = new THREE.Vector3();
  box.getSize(size);
  const heightScale = size.y > 1e-4 ? TARGET_HEIGHT / size.y : 1;
  const widestSpan = Math.max(size.x, size.z);
  const widthScale = widestSpan > 1e-4 ? TARGET_MAX_WIDTH / widestSpan : heightScale;
  const scale = Math.min(heightScale, widthScale);
  object.scale.setScalar(scale);
  object.updateMatrixWorld(true);
  const scaledBox = new THREE.Box3().setFromObject(object);
  // sit the model's lowest point on y = 0, and center it horizontally —
  // some characters aren't perfectly centered on their own local origin.
  object.position.y -= scaledBox.min.y;
  object.position.x -= (scaledBox.min.x + scaledBox.max.x) / 2;
  object.position.z -= (scaledBox.min.z + scaledBox.max.z) / 2;
}

export async function createAxieOverlay(canvas, sizePx, axieId = DEFAULT_AXIE_ID) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(sizePx, sizePx, false);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.copy(CAM_POS);
  camera.lookAt(LOOK_AT);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4a33, 1.2));
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(3, 6, 4);
  scene.add(dir);

  const loader = new GLTFLoader();
  const pivot = new THREE.Group();
  scene.add(pivot);

  let mixer = null;
  let actions = {};
  let current = null;
  let inner = null;
  let loadToken = 0;
  let flipOffset = 0; // manual 180deg rotate, on top of whatever heading GPS derives

  async function loadCharacter(id) {
    const myToken = ++loadToken;
    const gltf = await loader.loadAsync(glbPath(id));
    if (myToken !== loadToken) return; // a newer switch already started

    if (inner) pivot.remove(inner);
    inner = gltf.scene;
    inner.rotation.y = MESH_FACE_OFFSET;
    fitModelToFrame(inner);
    inner.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    pivot.add(inner);

    mixer = new THREE.AnimationMixer(inner);
    actions = {};
    gltf.animations.forEach((clip) => { actions[clip.name] = mixer.clipAction(clip); });
    current = null;
    if (actions.Idle) playAction('Idle', 0);
  }

  function playAction(name, fade = 0.25) {
    const next = actions[name];
    if (!next || next === current) return;
    if (current) current.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    current = next;
  }

  await loadCharacter(axieId);

  const lookHelper = new THREE.Object3D();
  let desiredQuat = pivot.quaternion.clone();

  // dx/dz are a direction in the overlay's own local ground plane, NOT pixels —
  // the caller converts real-world east/north meters into this convention
  // (east -> +x, north -> -z) so the icon's turn matches the real map's
  // north-up orientation.
  function setHeading(dx, dz) {
    if (Math.hypot(dx, dz) < 1e-5) return;
    lookHelper.position.set(0, 0, 0);
    lookHelper.lookAt(dx, 0, dz);
    const flipQuat = new THREE.Quaternion().setFromAxisAngle(UP_AXIS, flipOffset);
    desiredQuat.copy(lookHelper.quaternion).multiply(flipQuat);
  }

  // Manual 180-degree turn, for whenever the auto-heading has the character
  // facing a way that doesn't feel right (GPS heading is derived from
  // consecutive fixes and can be noisy at low speed). Persists across future
  // setHeading() calls until toggled again.
  function rotate180() {
    flipOffset = (flipOffset + Math.PI) % (Math.PI * 2);
    const flipQuat = new THREE.Quaternion().setFromAxisAngle(UP_AXIS, Math.PI);
    desiredQuat.premultiply(flipQuat);
  }

  const clock = new THREE.Clock();
  let raf = null;
  function loop() {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, clock.getDelta());
    if (mixer) mixer.update(dt);
    pivot.quaternion.slerp(desiredQuat, Math.min(1, dt * 6));
    renderer.render(scene, camera);
  }
  loop();

  function dispose() {
    if (raf) cancelAnimationFrame(raf);
    renderer.dispose();
  }

  return {
    playAction,
    setHeading,
    rotate180,
    dispose,
    setCharacter(id) { return loadCharacter(id); },
  };
}
