import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/** The subset of assembly state the digital twin needs to reflect. */
export interface RoverSnapshot {
  stage: number;
  step: number;
  shipped: boolean;
}

export interface RoverScene {
  updateRover(state: RoverSnapshot): void;
  triggerDiagnosticFx(toolName: string): void;
}

type Vec3 = [number, number, number];

/** Three.js digital twin: a light studio render matching the page's zinc/blue
 *  UI. Self-contained - the caller only ever calls `updateRover` (after any
 *  assembly-state change) and `triggerDiagnosticFx` (after a diagnostic-ish
 *  tool call); everything else (camera, lighting, animation) runs on its own. */
export function createRoverScene(viewport: HTMLElement): RoverScene {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0xeef0f3, 0.03);
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.set(7, 5.1, 10);
  camera.lookAt(0, 2.15, 0);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  viewport.prepend(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd6dae0, 1.5));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 8, 5);
  key.castShadow = true;
  scene.add(key);
  const rim = new THREE.PointLight(0x2563eb, 10, 12);
  rim.position.set(-4, 2, -2);
  scene.add(rim);
  const floor = new THREE.Mesh(
    new THREE.CylinderGeometry(4.5, 4.7, 0.18, 64),
    new THREE.MeshStandardMaterial({ color: 0xdfe3e8, roughness: 0.85, metalness: 0.05 }),
  );
  floor.position.y = -0.15;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(8, 16, 0xb8bfc7, 0xd8dce1);
  grid.position.y = -0.05;
  scene.add(grid);
  const rover = new THREE.Group();
  scene.add(rover);
  const navy = new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.45, metalness: 0.4 });
  const ivory = new THREE.MeshStandardMaterial({
    color: 0xe9ebee,
    roughness: 0.5,
    metalness: 0.12,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0x2563eb,
    roughness: 0.4,
    metalness: 0.3,
  });
  const metal = new THREE.MeshStandardMaterial({
    color: 0x9aa2ab,
    roughness: 0.32,
    metalness: 0.85,
  });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x3f4045,
    roughness: 0.38,
    metalness: 0.75,
  });
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x27292d,
    roughness: 0.8,
    metalness: 0.1,
  });
  const reactorMat = new THREE.MeshStandardMaterial({
    color: 0xfbbf24,
    emissive: 0xb45309,
    emissiveIntensity: 1.5,
    roughness: 0.2,
  });
  const sensorMat = new THREE.MeshStandardMaterial({
    color: 0x60a5fa,
    emissive: 0x1d4ed8,
    emissiveIntensity: 1.8,
    roughness: 0.15,
  });

  function part(
    g: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos: Vec3 = [0, 0, 0],
    rot: Vec3 = [0, 0, 0],
  ): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  }
  function block(
    g: THREE.Object3D,
    size: Vec3,
    pos: Vec3,
    mat: THREE.Material = navy,
    rot: Vec3 = [0, 0, 0],
    r = 0.08,
  ) {
    return part(
      g,
      new RoundedBoxGeometry(...size, 3, Math.min(r, ...size.map((v) => v * 0.18))),
      mat,
      pos,
      rot,
    );
  }
  function cylinder(
    g: THREE.Object3D,
    r: number,
    l: number,
    pos: Vec3,
    mat: THREE.Material = metal,
    rot: Vec3 = [0, 0, Math.PI / 2],
    segments = 16,
  ) {
    return part(g, new THREE.CylinderGeometry(r, r, l, segments), mat, pos, rot);
  }
  function bolt(g: THREE.Object3D, pos: Vec3, s = 1) {
    return cylinder(g, 0.055 * s, 0.045 * s, pos, darkMetal, [Math.PI / 2, 0, 0], 8);
  }
  function tube(g: THREE.Object3D, a: Vec3, b: Vec3, r: number, mat: THREE.Material = metal) {
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const m = part(
      g,
      new THREE.CylinderGeometry(r, r, start.distanceTo(end), 10),
      mat,
      start.clone().add(end).multiplyScalar(0.5).toArray() as Vec3,
    );
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().sub(start).normalize());
    return m;
  }
  function plate(
    g: THREE.Object3D,
    w: number,
    h: number,
    d: number,
    pos: Vec3,
    mat: THREE.Material = ivory,
    rot: Vec3 = [0, 0, 0],
  ) {
    const s = new THREE.Shape();
    s.moveTo(-w * 0.36, h * 0.5);
    s.lineTo(w * 0.36, h * 0.5);
    s.lineTo(w * 0.5, h * 0.18);
    s.lineTo(w * 0.43, -h * 0.42);
    s.lineTo(0, -h * 0.5);
    s.lineTo(-w * 0.43, -h * 0.42);
    s.lineTo(-w * 0.5, h * 0.18);
    s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, {
      depth: d,
      bevelEnabled: true,
      bevelSize: 0.045,
      bevelThickness: 0.035,
      bevelSegments: 2,
    });
    geo.center();
    return part(g, geo, mat, pos, rot);
  }

  const modules = {
    torso: new THREE.Group(),
    legs: new THREE.Group(),
    arms: new THREE.Group(),
    armor: new THREE.Group(),
    power: new THREE.Group(),
  };
  Object.values(modules).forEach((group) => {
    group.visible = false;
    rover.add(group);
  });

  // Forged torso cage, shield armor and diagonal load paths.
  cylinder(modules.torso, 0.43, 0.42, [0, 1.42, 0], darkMetal, [0, 0, Math.PI / 2], 24);
  cylinder(modules.torso, 0.34, 0.5, [0, 1.42, 0], metal, [0, 0, Math.PI / 2], 24);
  block(modules.torso, [1.9, 1.35, 0.86], [0, 2.42, 0], navy);
  plate(modules.torso, 1.62, 1.18, 0.13, [0, 2.48, 0.48]);
  for (const x of [-0.78, 0.78]) {
    tube(modules.torso, [x, 1.76, 0.42], [x * 0.72, 3.03, 0.43], 0.065, accent);
    bolt(modules.torso, [x, 2.82, 0.49], 1.15);
  }
  for (const y of [1.86, 2.98]) {
    cylinder(modules.torso, 0.09, 2.12, [0, y, 0]);
    for (const x of [-0.91, 0.91]) bolt(modules.torso, [x, y, 0.48]);
  }
  // Side ribs, shoulder guards and waist skirt plates break up the torso slab.
  for (const s of [-1, 1]) {
    for (const y of [2.12, 2.44, 2.76])
      block(modules.torso, [0.1, 0.2, 0.62], [s * 0.96, y, 0], darkMetal, [0, 0, 0], 0.03);
    block(
      modules.torso,
      [0.34, 0.16, 0.22],
      [s * 0.58, 3.06, 0.38],
      darkMetal,
      [0, 0, s * 0.28],
      0.04,
    );
    plate(modules.torso, 0.52, 0.5, 0.14, [s * 0.58, 1.62, 0.3], navy, [0, 0, s * -0.14]);
    bolt(modules.torso, [s * 0.58, 1.62, 0.42], 0.9);
  }
  // Twin hydraulic legs, exposed knee races and ice-grip feet.
  for (const x of [-0.62, 0.62]) {
    cylinder(modules.legs, 0.25, 0.48, [x, 1.28, 0], darkMetal, [0, 0, Math.PI / 2], 24);
    cylinder(modules.legs, 0.17, 0.56, [x, 1.28, 0]);
    tube(modules.legs, [x - 0.17, 1.18, 0], [x - 0.17, 0.35, 0.02], 0.095);
    tube(modules.legs, [x + 0.17, 1.18, 0], [x + 0.17, 0.35, 0.02], 0.095);
    plate(modules.legs, 0.64, 0.92, 0.38, [x, 0.74, 0.18], navy);
    cylinder(modules.legs, 0.27, 0.5, [x, 0.24, 0], darkMetal, [0, 0, Math.PI / 2], 20);
    tube(modules.legs, [x, 0.08, 0], [x, -0.63, 0.04], 0.14);
    plate(modules.legs, 0.72, 0.92, 0.42, [x, -0.4, 0.2]);
    block(modules.legs, [0.82, 0.3, 1.18], [x, -0.94, 0.18]);
    block(modules.legs, [0.72, 0.12, 1.02], [x, -1.08, 0.22], rubber, [0, 0, 0], 0.04);
    for (const sx of [-0.22, 0.22]) bolt(modules.legs, [x + sx, 0.24, 0.28], 0.9);
  }
  // Asymmetric rescue arms: left thermal cutter, right debris clamp.
  for (const x of [-1.36, 1.36]) {
    const s = Math.sign(x);
    cylinder(modules.arms, 0.36, 0.34, [x, 2.82, 0], darkMetal, [0, 0, Math.PI / 2], 24);
    cylinder(modules.arms, 0.22, 0.42, [x, 2.82, 0], x < 0 ? accent : ivory);
    tube(modules.arms, [x, 2.57, 0.02], [x, 1.76, 0.22], 0.15);
    plate(modules.arms, 0.62, 0.78, 0.36, [x, 2.13, 0.34], navy, [0.16, 0, 0]);
    cylinder(modules.arms, 0.23, 0.36, [x, 1.62, 0.26], darkMetal);
    block(modules.arms, [0.56, 0.3, 0.66], [x, 3.16, 0], navy, [0, 0, s * 0.12], 0.06);
    block(
      modules.arms,
      [0.4, 0.14, 0.5],
      [x + s * 0.06, 3.34, 0],
      darkMetal,
      [0, 0, s * 0.12],
      0.04,
    );
    tube(modules.arms, [x + s * 0.16, 2.5, -0.22], [x + s * 0.04, 1.86, -0.14], 0.045, metal);
    tube(modules.arms, [x + s * 0.16, 2.5, -0.22], [x + s * 0.1, 2.18, -0.18], 0.07, darkMetal);
  }
  // Simple two-finger utility grippers on collared wrists.
  for (const s of [-1, 1]) {
    const x = s * 1.36;
    const hx = s * 1.4;
    tube(modules.arms, [x, 1.48, 0.24], [hx, 0.92, 0.58], 0.13);
    cylinder(modules.arms, 0.155, 0.16, [hx, 1.02, 0.5], metal, [0.34, 0, 0], 14);
    block(modules.arms, [0.4, 0.34, 0.4], [hx, 0.8, 0.6], accent, [0.32, 0, 0], 0.07);
    for (const f of [-0.11, 0.11])
      block(modules.arms, [0.09, 0.3, 0.22], [hx + f, 0.58, 0.72], darkMetal, [0.32, 0, 0], 0.03);
  }
  // Utility head unit: collar armor, rounded sensor head with a single visor bar,
  // side sensor pods and a short antenna mast - engineering hardware, not a face.
  block(modules.armor, [1.34, 0.4, 0.82], [0, 3.3, -0.08], darkMetal);
  plate(modules.armor, 0.82, 0.66, 0.16, [0, 3.23, 0.47], ivory);
  block(modules.armor, [0.8, 0.58, 0.64], [0, 3.86, 0], ivory, [0, 0, 0], 0.14);
  block(modules.armor, [0.68, 0.17, 0.1], [0, 3.9, 0.31], darkMetal, [0, 0, 0], 0.03);
  part(modules.armor, new THREE.BoxGeometry(0.56, 0.09, 0.03), sensorMat, [0, 3.9, 0.36]);
  for (const s of [-1, 1]) {
    cylinder(modules.armor, 0.11, 0.15, [s * 0.44, 3.86, 0], darkMetal, [0, 0, Math.PI / 2], 14);
    part(
      modules.armor,
      new THREE.TorusGeometry(0.11, 0.02, 8, 20),
      accent,
      [s * 0.5, 3.86, 0],
      [0, Math.PI / 2, 0],
    );
  }
  cylinder(modules.armor, 0.028, 0.34, [0.3, 4.28, -0.12], metal, [0, 0, 0], 8);
  part(modules.armor, new THREE.SphereGeometry(0.05, 10, 8), accent, [0.3, 4.46, -0.12]);
  for (const x of [-0.78, 0.78])
    plate(modules.armor, 0.76, 0.28, 0.14, [x, 3.62, 0.18], navy, [
      0,
      x < 0 ? -0.12 : 0.12,
      x < 0 ? -0.08 : 0.08,
    ]);
  for (const x of [-0.5, 0.5]) bolt(modules.armor, [x, 3.65, 0.31], 0.75);
  for (const x of [-1.04, 1.04]) {
    plate(modules.armor, 0.58, 0.68, 0.18, [x, 3.02, 0.08], ivory, [
      0,
      x < 0 ? -0.18 : 0.18,
      x < 0 ? -0.2 : 0.2,
    ]);
    bolt(modules.armor, [x, 3.03, 0.22], 0.9);
  }
  // Nested reactor containment rings and paired external power conduits.
  const ringLayers: Array<[number, number, THREE.Material]> = [
    [0.48, 0.08, darkMetal],
    [0.38, 0.055, accent],
    [0.27, 0.1, reactorMat],
  ];
  for (const [r, t, m] of ringLayers)
    part(modules.power, new THREE.TorusGeometry(r, t, 10, 36), m, [0, 2.47, 0.58]);
  part(modules.power, new THREE.CircleGeometry(0.23, 32), reactorMat, [0, 2.47, 0.585]);
  for (const x of [-0.58, 0.58]) {
    tube(modules.power, [x, 2.78, -0.32], [x * 0.72, 2.62, 0.48], 0.035, accent);
    tube(modules.power, [x, 2.71, -0.34], [x * 0.68, 2.55, 0.49], 0.025);
  }
  block(modules.power, [1.18, 0.72, 0.3], [0, 2.34, -0.58], accent);
  block(modules.power, [0.34, 1.18, 0.34], [-0.48, 2.45, -0.82], darkMetal);
  block(modules.power, [0.34, 1.18, 0.34], [0.48, 2.45, -0.82], darkMetal);
  for (const x of [-0.48, 0.48]) {
    cylinder(modules.power, 0.13, 0.34, [x, 3.08, -0.82], accent, [0, 0, 0], 12);
    bolt(modules.power, [x, 2.08, -1.02], 0.9);
  }
  for (const x of [-0.43, 0.43]) bolt(modules.power, [x, 2.34, -0.75], 1.1);

  // Faceted inventory hologram previews the finished silhouette.
  const blueprint = new THREE.Group();
  const blueprintMat = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    wireframe: true,
    transparent: true,
    opacity: 0.2,
  });
  const blueprintParts: Array<[THREE.BufferGeometry, Vec3, Vec3]> = [
    [new THREE.DodecahedronGeometry(1.05), [0, 2.48, 0], [0, 0, 0]],
    [new THREE.CylinderGeometry(0.48, 0.7, 2.4, 8), [-0.62, 0.05, 0], [0, 0, 0]],
    [new THREE.CylinderGeometry(0.48, 0.7, 2.4, 8), [0.62, 0.05, 0], [0, 0, 0]],
    [new THREE.CylinderGeometry(0.34, 0.48, 2.2, 8), [-1.42, 1.9, 0], [0, 0, -0.08]],
    [new THREE.CylinderGeometry(0.34, 0.48, 2.2, 8), [1.42, 1.9, 0], [0, 0, 0.08]],
    [new THREE.DodecahedronGeometry(0.48), [0, 3.95, 0], [0, 0, 0]],
  ];
  for (const [geo, pos, rot] of blueprintParts) part(blueprint, geo, blueprintMat, pos, rot);
  rover.add(blueprint);

  const diagnosticFx = new THREE.Group();
  diagnosticFx.visible = false;
  rover.add(diagnosticFx);
  // Normal blending: additive glow washes out against the light studio backdrop.
  const diagnosticScanMat = new THREE.MeshBasicMaterial({
    color: 0x2563eb,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const diagnosticHaloMat = new THREE.MeshBasicMaterial({
    color: 0xd97706,
    transparent: true,
    opacity: 0,
    depthWrite: false,
  });
  const diagnosticScan = part(
    diagnosticFx,
    new THREE.TorusGeometry(2.05, 0.022, 8, 72),
    diagnosticScanMat,
    [0, 1.8, 0],
    [Math.PI / 2, 0, 0],
  );
  const diagnosticHalos: THREE.Mesh[] = [];
  const haloPositions: Vec3[] = [
    [-1.36, 2.82, 0.22],
    [1.36, 2.82, 0.22],
    [-0.62, 0.24, 0.3],
    [0.62, 0.24, 0.3],
  ];
  for (const pos of haloPositions)
    diagnosticHalos.push(
      part(diagnosticFx, new THREE.TorusGeometry(0.34, 0.018, 8, 36), diagnosticHaloMat, pos),
    );
  const diagnosticLight = new THREE.PointLight(0x2563eb, 0, 6, 2);
  diagnosticLight.position.set(0, 2, 0.8);
  diagnosticFx.add(diagnosticLight);
  let diagnosticFxStarted = -Infinity;

  function triggerDiagnosticFx(name: string) {
    diagnosticFxStarted = performance.now() / 1000;
    const isTest = name.includes('test') || name.includes('diagnostic') || name.includes('report');
    diagnosticScanMat.color.setHex(isTest ? 0x15803d : 0x2563eb);
    diagnosticLight.color.setHex(isTest ? 0x15803d : 0x2563eb);
    diagnosticHaloMat.color.setHex(
      name.includes('calibrate') || name.includes('joint') ? 0xd97706 : 0x60a5fa,
    );
  }

  const rings: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(4.8 + i * 0.5, 0.008, 8, 100),
      new THREE.MeshBasicMaterial({ color: 0xaab2bb, transparent: true, opacity: 0.4 - i * 0.09 }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.02;
    rings.push(ring);
    scene.add(ring);
  }

  let latest: RoverSnapshot = { stage: 0, step: 0, shipped: false };
  function updateRover(next: RoverSnapshot) {
    latest = next;
    const s = next.stage;
    const progress = next.step;
    blueprint.visible = s === 0;
    modules.torso.visible = s > 1 || (s === 1 && progress > 0);
    modules.legs.visible = s > 1 || (s === 1 && progress >= 2);
    modules.arms.visible = s > 1 || (s === 1 && progress >= 3);
    modules.armor.visible = s > 1 || (s === 1 && progress >= 4);
    modules.power.visible = s >= 2 || next.shipped;
    sensorMat.color.setHex(next.shipped ? 0x4ade80 : 0x60a5fa);
    sensorMat.emissive.setHex(next.shipped ? 0x15803d : 0x1d4ed8);
  }

  let drag = false;
  let lastX = 0;
  let targetRot = Math.atan2(camera.position.x, camera.position.z);
  renderer.domElement.addEventListener('pointerdown', (e) => {
    drag = true;
    lastX = e.clientX;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (drag) {
      targetRot += (e.clientX - lastX) * 0.008;
      lastX = e.clientX;
    }
  });
  renderer.domElement.addEventListener('pointerup', () => (drag = false));

  function resize() {
    const w = viewport.clientWidth;
    const h = viewport.clientHeight;
    if (!w || !h) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  new ResizeObserver(resize).observe(viewport);

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clock = new THREE.Clock();
  function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    rover.rotation.y += (targetRot - rover.rotation.y) * 0.06;
    rover.position.y = 1.1 + (reduceMotion ? 0 : Math.sin(t * 1.2) * 0.04);
    blueprintMat.opacity = reduceMotion ? 0.2 : 0.16 + Math.sin(t * 2) * 0.07;
    reactorMat.emissiveIntensity = reduceMotion ? 1.5 : 1.4 + Math.sin(t * 2.4) * 0.25;
    const donePulse = reduceMotion ? 1 : 0.88 + Math.sin(t * 2.1) * 0.12;
    sensorMat.emissiveIntensity = latest.shipped ? 3.2 * donePulse : 1.8;
    const fxAge = performance.now() / 1000 - diagnosticFxStarted;
    const fxProgress = Math.min(1, fxAge / (reduceMotion ? 0.8 : 1.65));
    const fxActive = fxProgress < 1;
    diagnosticFx.visible = fxActive;
    if (fxActive) {
      const strength = reduceMotion ? 1 : Math.sin(fxProgress * Math.PI);
      diagnosticScan.position.y = reduceMotion ? 1.8 : -0.95 + fxProgress * 5.2;
      diagnosticScanMat.opacity = 0.72 * strength;
      diagnosticHaloMat.opacity = 0.55 * strength;
      diagnosticLight.intensity = 5 * strength;
      diagnosticHalos.forEach((halo, i) => {
        halo.rotation.z = reduceMotion ? 0 : t * (0.7 + i * 0.08);
        halo.scale.setScalar(1 + strength * 0.18);
      });
    }
    rings.forEach((r, i) => (r.rotation.z = t * (0.025 + i * 0.012)));
    renderer.render(scene, camera);
  }
  animate();

  return { updateRover, triggerDiagnosticFx };
}
