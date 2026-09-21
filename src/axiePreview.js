import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glbPath } from './axieCatalog.js';

/* =============================================================================
   The rotating "showroom" viewer used inside the Axie picker overlay
   (axiePicker.js) — loads whichever character the user taps, plays its Idle
   clip, and slowly turns it so you can see it in full 3D before confirming.
   ============================================================================= */

const MESH_FACE_OFFSET = Math.PI;
const MODEL_SCALE = 1.4;

export function createCharacterPreview(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 1.55, 4.1);
  camera.lookAt(0, 0.95, 0);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a4a33, 1.25));
  const dir = new THREE.DirectionalLight(0xffffff, 1.1);
  dir.position.set(3, 6, 4);
  scene.add(dir);

  const pivot = new THREE.Group();
  scene.add(pivot);

  const loader = new GLTFLoader();
  let mixer = null, inner = null, loadToken = 0, currentAction = null;

  async function show(id) {
    const myToken = ++loadToken;
    let gltf;
    try {
      gltf = await loader.loadAsync(glbPath(id));
    } catch (e) {
      console.warn('preview failed to load', id, e);
      return false;
    }
    if (myToken !== loadToken) return false;
    if (inner) pivot.remove(inner);
    inner = gltf.scene;
    inner.scale.setScalar(MODEL_SCALE);
    inner.rotation.y = MESH_FACE_OFFSET;
    pivot.add(inner);
    mixer = new THREE.AnimationMixer(inner);
    const idle = THREE.AnimationClip.findByName(gltf.animations, 'Idle') || gltf.animations[0];
    if (idle) { currentAction = mixer.clipAction(idle); currentAction.play(); }
    return true;
  }

  function resize() {
    const size = canvas.clientWidth || canvas.parentElement.clientWidth;
    if (!size) return;
    renderer.setSize(size, size, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  const clock = new THREE.Clock();
  let raf = null;
  function loop() {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, clock.getDelta());
    if (mixer) mixer.update(dt);
    pivot.rotation.y += dt * 0.55;
    renderer.render(scene, camera);
  }
  loop();

  function dispose() {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    renderer.dispose();
  }

  return { show, resize, dispose };
}
