import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { glbPath, DEFAULT_AXIE_ID } from './axieCatalog.js';

/* =============================================================================
   "3D World" mode — an alternative to the real Leaflet map for the Track
   view. Your Axie walks/runs through a stylized 3D field instead of a real
   street map, driven by the exact same real-GPS distance numbers the map
   view uses (see main.js's applyFix -> world.advance(meters) call) — this
   is a different VISUALIZATION of your real movement, not a simulated walk.

   Why procedural, not pulled from a repo: the two Axie asset repos named in
   the feature request cover different things. axie-origins-asset-kit is a
   2D battle-VFX/Spine kit built for a Unity mobile game (particle atlases,
   arena background art, no exportable 3D scene format) — there's no 3D
   "world" file in it we could drop into a Three.js scene. jaatster's
   axie-3d-assets IS real 3D (glTF mascots with Idle/Walk/Run — see
   axieCatalog.js/axie3d.js) but ships characters only, no environment. So
   this field — ground, sky, trees, rocks — is built here with plain Three.js
   primitives in the same stylized-low-poly direction as the rest of the app,
   rather than mis-describing borrowed VFX art as a "3D world" it isn't.

   Implementation is a classic endless-runner recycle: a handful of ground
   "chunks" (each with its own scattered trees/rocks) sit end-to-end ahead of
   a fixed camera+character; advancing shifts every chunk toward the camera
   by the walked distance, and any chunk that passes behind the camera gets
   moved back to the far end and re-scattered. Nothing about GPS or distance
   accounting lives in here — this module only ever renders motion it's told
   about.
   ============================================================================= */

const MESH_FACE_OFFSET = Math.PI;
const MODEL_SCALE = 1.3;
const CHUNK_LEN = 18;
const NUM_CHUNKS = 7;
const TRACK_HALF_WIDTH = 3.1; // the walkable path stays clear of props
const FIELD_HALF_WIDTH = 11;

function makeGrassTexture() {
  const size = 256;
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = size;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#2f5a3a';
  ctx.fillRect(0, 0, size, size);
  // scattered blade flecks for texture
  for (let i = 0; i < 700; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    ctx.fillStyle = Math.random() > 0.5 ? 'rgba(70,120,80,0.5)' : 'rgba(20,45,30,0.45)';
    ctx.fillRect(x, y, 2, 6);
  }
  // a worn amber-tinted path stripe down the middle, echoing the map trail
  const pathW = size * 0.30;
  const grad = ctx.createLinearGradient((size - pathW) / 2, 0, (size + pathW) / 2, 0);
  grad.addColorStop(0, 'rgba(120,90,50,0)');
  grad.addColorStop(0.5, 'rgba(150,110,60,0.55)');
  grad.addColorStop(1, 'rgba(120,90,50,0)');
  ctx.fillStyle = grad;
  ctx.fillRect((size - pathW) / 2, 0, pathW, size);
  const tex = new THREE.CanvasTexture(cnv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 3);
  return tex;
}

function makeSkyTexture() {
  const w = 8, h = 128;
  const cnv = document.createElement('canvas');
  cnv.width = w; cnv.height = h;
  const ctx = cnv.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, '#1c3f52');
  grad.addColorStop(0.55, '#3a6d6a');
  grad.addColorStop(1, '#8fc79a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cnv);
  return tex;
}

function buildTree() {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.13, 0.9, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a30 })
  );
  trunk.position.y = 0.45;
  const leafColor = [0x4f9a5c, 0x5cae6a, 0x3f8a52][Math.floor(Math.random() * 3)];
  const leaves = new THREE.Mesh(
    new THREE.ConeGeometry(0.62, 1.4, 7),
    new THREE.MeshLambertMaterial({ color: leafColor })
  );
  leaves.position.y = 1.35;
  g.add(trunk, leaves);
  const s = 0.8 + Math.random() * 0.7;
  g.scale.setScalar(s);
  g.rotation.y = Math.random() * Math.PI * 2;
  return g;
}

function buildRock() {
  const rock = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.32, 0),
    new THREE.MeshLambertMaterial({ color: 0x8a8a86 })
  );
  rock.position.y = 0.18;
  rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, 0);
  const s = 0.6 + Math.random() * 0.9;
  rock.scale.setScalar(s);
  return rock;
}

function scatterChunk(group, grassTex) {
  group.clear();
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(FIELD_HALF_WIDTH * 2, CHUNK_LEN),
    new THREE.MeshLambertMaterial({ map: grassTex })
  );
  ground.rotation.x = -Math.PI / 2;
  group.add(ground);

  const propCount = 5 + Math.floor(Math.random() * 5);
  for (let i = 0; i < propCount; i++) {
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (TRACK_HALF_WIDTH + Math.random() * (FIELD_HALF_WIDTH - TRACK_HALF_WIDTH - 0.6));
    const z = (Math.random() - 0.5) * CHUNK_LEN;
    const prop = Math.random() < 0.65 ? buildTree() : buildRock();
    prop.position.set(x, prop.position.y || 0, z);
    group.add(prop);
  }
}

export async function createAxieWorld(canvas, axieId = DEFAULT_AXIE_ID) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const skyTex = makeSkyTexture();
  scene.background = skyTex;
  scene.fog = new THREE.Fog(0x3a6d6a, CHUNK_LEN * 2.2, CHUNK_LEN * (NUM_CHUNKS - 1));

  const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);

  scene.add(new THREE.HemisphereLight(0xbfe3ff, 0x3a4a2e, 1.15));
  const sun = new THREE.DirectionalLight(0xfff3d6, 1.15);
  sun.position.set(5, 9, 6);
  scene.add(sun);

  const grassTex = makeGrassTexture();
  const chunks = [];
  for (let i = 0; i < NUM_CHUNKS; i++) {
    const g = new THREE.Group();
    scatterChunk(g, grassTex);
    g.position.z = -i * CHUNK_LEN;
    scene.add(g);
    chunks.push(g);
  }
  // world Z position that increases as the player advances — chunks are laid
  // out relative to this so recycling is just bookkeeping on plain numbers.
  let traveled = 0;

  const pivot = new THREE.Group();
  pivot.position.set(0, 0, 0);
  scene.add(pivot);

  let mixer = null, actions = {}, current = null, inner = null, loadToken = 0;
  const loader = new GLTFLoader();

  async function loadCharacter(id) {
    const myToken = ++loadToken;
    const gltf = await loader.loadAsync(glbPath(id));
    if (myToken !== loadToken) return;
    if (inner) pivot.remove(inner);
    inner = gltf.scene;
    inner.scale.setScalar(MODEL_SCALE);
    inner.rotation.y = MESH_FACE_OFFSET;
    inner.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
    pivot.add(inner);
    mixer = new THREE.AnimationMixer(inner);
    actions = {};
    gltf.animations.forEach((clip) => { actions[clip.name] = mixer.clipAction(clip); });
    current = null;
    playAction(pendingState === 'run' ? 'Run' : pendingState === 'walk' ? 'Walk' : 'Idle', 0);
  }

  function playAction(name, fade = 0.3) {
    const next = actions[name];
    if (!next || next === current) return;
    if (current) current.fadeOut(fade);
    next.reset().fadeIn(fade).play();
    current = next;
  }

  let pendingState = 'idle';
  function setSpeedState(s) {
    pendingState = s;
    playAction(s === 'run' ? 'Run' : s === 'walk' ? 'Walk' : 'Idle');
  }

  await loadCharacter(axieId);

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  window.addEventListener('resize', resize);

  // Advances the world by real walked meters (1 world unit == 1 meter, so
  // pace on screen matches your real elapsed time, not a sped-up simulation).
  function advance(meters) {
    if (!meters || meters <= 0) return;
    traveled += meters;
    for (const chunk of chunks) {
      chunk.position.z += meters;
      // once a chunk has fully passed behind the camera, send it back to the
      // far end of the line and re-scatter its trees/rocks for variety
      if (chunk.position.z > CHUNK_LEN * 1.5) {
        chunk.position.z -= NUM_CHUNKS * CHUNK_LEN;
        scatterChunk(chunk, grassTex);
      }
    }
  }

  const clock = new THREE.Clock();
  let raf = null;
  function loop() {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.1, clock.getDelta());
    if (mixer) mixer.update(dt);
    const t = clock.elapsedTime;
    const bobAmp = pendingState === 'run' ? 0.09 : pendingState === 'walk' ? 0.05 : 0.015;
    const bobSpeed = pendingState === 'run' ? 9 : 6;
    const bob = Math.sin(t * bobSpeed) * bobAmp;
    camera.position.set(0, 2.9 + bob * 0.3, 5.8);
    camera.lookAt(0, 1.05 + bob, -2.6);
    pivot.position.y = bob * 0.5;
    renderer.render(scene, camera);
  }
  loop();

  function dispose() {
    if (raf) cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    renderer.dispose();
  }

  return {
    advance,
    setSpeedState,
    setCharacter(id) { return loadCharacter(id); },
    resize,
    dispose,
  };
}
