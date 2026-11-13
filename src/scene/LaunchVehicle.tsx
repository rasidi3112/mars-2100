import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Aeroshell, type Signal } from './Vehicles';
import { NOISE_GLSL } from './glsl';

// The launch vehicle, in metres, y up, with its base at y = 0.
//
// A conceptual heavy crew rocket for the year 2100. Its layout and size follow the class of
// NASA's Space Launch System (OBSERVED: 98 m tall, an 8.4 m core with four engines, two 54 m
// solid boosters, a launch abort tower over the crew capsule), but the design, the markings and
// the performance shown are invented. It carries the same capsule and service module that are
// seen later during the cruise and the entry.

export const STACK = {
  height: 98.4,
  coreRadius: 4.2,
  coreTop: 64.6,
  boosterOffset: 6.3,
  boosterRadius: 1.85,
  adapterTop: 72,
  upperTop: 78,
  capsuleBase: 85,
  hatchY: 86.5,
  hatchRadius: 3.2,
} as const;

// What the director tells the vehicle every frame.
export interface FlightState {
  core: number; // main engine throttle 0..1
  boosters: number; // solid booster throttle 0..1
  upper: number; // upper stage throttle 0..1
  spread: number; // plume widening as the air thins
  clipY: number; // world height below which plumes are hidden (inside the launch platform)
  sinceBoosterSep: number; // story seconds since the event; negative before it
  sinceAbortJettison: number;
  sinceStageSep: number;
  sky: number; // 1 at the ground, 0 in space: how much sky light reaches the hull
}

export function createFlightState(): FlightState {
  return { core: 0, boosters: 0, upper: 0, spread: 1, clipY: -1e9, sinceBoosterSep: -1, sinceAbortJettison: -1, sinceStageSep: -1, sky: 1 };
}

// ---------- exhaust ----------

const flameVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying float vWorldY;
  void main() {
    vUv = uv;
    vNormalV = normalize(normalMatrix * normal);
    vWorldY = (modelMatrix * vec4(position, 1.0)).y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const flameFragment = /* glsl */ `
  uniform float uTime;
  uniform float uThrottle;
  uniform float uSeed;
  uniform float uClipY;
  uniform float uDiamonds;
  uniform vec3 uHot;
  uniform vec3 uMid;
  uniform vec3 uTail;
  uniform float uGain;
  varying vec2 vUv;
  varying vec3 vNormalV;
  varying float vWorldY;
  ${NOISE_GLSL}
  void main() {
    if (vWorldY < uClipY) discard; // the launch platform hides the plume below its deck
    float t = 1.0 - vUv.y;
    float core = pow(abs(vNormalV.z), 1.4);
    float flick = vnoise(vec3(vUv.x * 7.0, t * 9.0 - uTime * 16.0, uTime * 3.0 + uSeed));
    float body = (1.0 - t) * core * (0.7 + 0.6 * flick);
    float diamonds = (0.5 + 0.5 * cos(t * 30.0 - 0.6)) * (1.0 - smoothstep(0.0, 0.55, t)) * uDiamonds;
    vec3 colour = mix(uHot, uMid, smoothstep(0.0, 0.3, t));
    colour = mix(colour, uTail, smoothstep(0.3, 0.85, t));
    float alpha = clamp(body * (1.0 + diamonds) * uThrottle * 1.7, 0.0, 1.0) * (1.0 - smoothstep(0.7, 1.0, t));
    gl_FragColor = vec4(colour * alpha * uGain, alpha);
  }
`;

type PlumeKind = 'solid' | 'hydrogen';

function createPlumeMaterial(kind: PlumeKind, seed: number) {
  const solid = kind === 'solid';
  return new THREE.ShaderMaterial({
    vertexShader: flameVertex,
    fragmentShader: flameFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: {
      uTime: { value: 0 }, uThrottle: { value: 0 }, uSeed: { value: seed * 4.3 }, uClipY: { value: -1e9 },
      uDiamonds: { value: solid ? 0.15 : 0.9 },
      // Solid boosters burn bright orange-white; hydrogen engines make a pale, almost clear flame.
      uHot: { value: solid ? new THREE.Vector3(1.0, 0.97, 0.9) : new THREE.Vector3(0.95, 0.97, 1.0) },
      uMid: { value: solid ? new THREE.Vector3(1.0, 0.76, 0.36) : new THREE.Vector3(0.62, 0.74, 1.0) },
      uTail: { value: solid ? new THREE.Vector3(0.95, 0.36, 0.1) : new THREE.Vector3(0.4, 0.5, 0.95) },
      uGain: { value: solid ? 1.9 : 0.42 },
    },
  });
}

function createGlowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,244,220,1)');
  g.addColorStop(0.18, 'rgba(255,190,110,0.75)');
  g.addColorStop(0.5, 'rgba(255,120,40,0.18)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ---------- painted hull textures ----------

function seeded(seed: number) {
  let value = seed;
  return () => { value = (value * 16807) % 2147483647; return (value - 1) / 2147483646; };
}

function weather(ctx: CanvasRenderingContext2D, width: number, height: number, seed: number) {
  const rand = seeded(seed);
  for (let i = 0; i < 2600; i += 1) {
    const shade = 222 + Math.floor(rand() * 24);
    ctx.fillStyle = `rgba(${shade},${shade - 3},${shade - 9},0.32)`;
    ctx.fillRect(rand() * width, rand() * height, 2 + rand() * 6, 1 + rand() * 3);
  }
}

// Core stage: white paint, weld lines, ribbed intertank, black roll-pattern panels, the mission name.
function createCoreTexture() {
  const width = 1024;
  const height = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#efebe3';
  ctx.fillRect(0, 0, width, height);
  weather(ctx, width, height, 913);
  // v = 0 is the top of the stage. Barrel welds.
  ctx.strokeStyle = 'rgba(112,108,100,0.5)';
  ctx.lineWidth = 3;
  for (const v of [0.035, 0.2, 0.3, 0.46, 0.62, 0.78, 0.9, 0.965]) { ctx.beginPath(); ctx.moveTo(0, v * height); ctx.lineTo(width, v * height); ctx.stroke(); }
  // Intertank: closely spaced stringers.
  ctx.fillStyle = 'rgba(205,199,188,0.9)';
  ctx.fillRect(0, 0.2 * height, width, 0.1 * height);
  ctx.strokeStyle = 'rgba(120,114,104,0.55)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= width; x += 12) { ctx.beginPath(); ctx.moveTo(x, 0.2 * height); ctx.lineTo(x, 0.3 * height); ctx.stroke(); }
  // Roll-pattern panels: quarters near the top, a band at the engine section.
  ctx.fillStyle = '#1b1f24';
  for (let i = 0; i < 4; i += 2) ctx.fillRect((i * width) / 4, 0.035 * height, width / 4, 0.085 * height);
  for (let i = 1; i < 4; i += 2) ctx.fillRect((i * width) / 4, 0.9 * height, width / 4, 0.065 * height);
  ctx.fillRect(0, 0.965 * height, width, 0.035 * height);
  // Cable tray down one side.
  ctx.fillStyle = 'rgba(96,92,86,0.85)';
  ctx.fillRect(width * 0.615, 0.3 * height, 12, 0.6 * height);
  // Mission name, written up the south and north faces (the boosters cover east and west).
  for (const u of [0, 0.5, 1]) {
    ctx.save();
    ctx.translate(width * u, height * 0.6);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = '#1b1f24';
    ctx.font = '600 104px "Space Grotesk", "Helvetica Neue", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('MARS 2100', 0, 0);
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// Boosters: white segments with joint lines and black marker bands.
function createBoosterTexture() {
  const width = 256;
  const height = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#f1eee7';
  ctx.fillRect(0, 0, width, height);
  weather(ctx, width, height, 377);
  ctx.strokeStyle = 'rgba(96,92,86,0.6)';
  ctx.lineWidth = 3;
  for (const v of [0.12, 0.3, 0.48, 0.66, 0.84]) { ctx.beginPath(); ctx.moveTo(0, v * height); ctx.lineTo(width, v * height); ctx.stroke(); }
  ctx.fillStyle = '#1b1f24';
  ctx.fillRect(0, 0.105 * height, width, 0.012 * height);
  ctx.fillRect(0, 0.9 * height, width, 0.03 * height);
  for (let i = 0; i < 8; i += 2) ctx.fillRect((i * width) / 8, 0.07 * height, width / 8, 0.035 * height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

// ---------- shapes ----------

const lathe = (points: [number, number][], segments = 48) => new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0001), y)), segments);

// Radius of the abort-system fairing that covers the capsule, at stack height y.
export function fairingRadius(y: number) {
  const t = Math.min(1, Math.max(0, (y - 85.2) / 6.4));
  return 0.55 + (3.36 - 0.55) * (1 - Math.pow(t, 1.7));
}

function useStackGeometry() {
  return useMemo(() => {
    // Textured bodies use two-point profiles so the paint maps evenly along their height.
    const core = lathe([[4.2, 3.4], [4.2, STACK.coreTop]], 64);
    const coreSkirt = lathe([[3.6, 1.6], [4.2, 3.4]], 64);
    const adapter = lathe([[4.2, STACK.coreTop], [4.2, 65.4], [2.58, 71.6], [2.58, STACK.adapterTop]], 64);
    const booster = lathe([[1.85, 3.4], [1.85, 47.6]], 40);
    const boosterSkirt = lathe([[2.55, 0.0], [2.2, 2.6], [1.85, 3.4]], 40);
    const boosterNose = lathe([[1.85, 47.6], [1.6, 49.6], [0.95, 52.2], [0.25, 53.6], [0.0, 53.9]], 40);
    const fairing: [number, number][] = [[3.36, 84.6], [3.36, 85.2]];
    for (let i = 1; i <= 16; i += 1) { const y = 85.2 + (6.4 * i) / 16; fairing.push([fairingRadius(y), y]); }
    const bell = (r: number, len: number) => lathe([[r * 0.4, 0], [r * 0.5, -len * 0.18], [r * 0.74, -len * 0.55], [r, -len]], 32);
    return {
      core,
      coreSkirt,
      adapter,
      booster,
      boosterSkirt,
      boosterNose,
      fairing: lathe(fairing, 56),
      tower: lathe([[0.55, 91.6], [0.48, 92.2], [0.48, 94.2], [0.86, 94.9], [0.86, 95.5], [0.5, 96.1], [0.44, 97.0], [0.0, 98.4]], 28),
      coreBell: bell(1.15, 3.0),
      boosterBell: bell(1.75, 2.6),
      upperBell: bell(1.05, 2.6),
      // One of three panels around the service module.
      panel: new THREE.CylinderGeometry(3.36, 3.36, 5.8, 20, 1, true, 0.04, (Math.PI * 2) / 3 - 0.08),
    };
  }, []);
}

const engineMetal = new THREE.MeshStandardMaterial({ color: '#3a3430', roughness: 0.35, metalness: 0.9, side: THREE.DoubleSide, emissive: '#ff6a1a', emissiveIntensity: 0 });
const darkBand = new THREE.MeshStandardMaterial({ color: '#1f2328', roughness: 0.5, metalness: 0.35 });
const steel = new THREE.MeshStandardMaterial({ color: '#aeb5bd', roughness: 0.32, metalness: 0.85 });
const windowGlass = new THREE.MeshStandardMaterial({ color: '#0d1318', roughness: 0.12, metalness: 0.7 });
const flash = new THREE.MeshBasicMaterial({ color: '#fff0d0', transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
const ZERO: Signal = { current: 0 };
const CORE_ENGINES: [number, number][] = [[1.75, 1.75], [-1.75, 1.75], [1.75, -1.75], [-1.75, -1.75]];

function Plume({ material, geometry, radius, length }: { material: THREE.ShaderMaterial; geometry: THREE.BufferGeometry; radius: number; length: number }) {
  // Drawn after the smoke, so the flame stays visible through the steam at liftoff.
  return <mesh geometry={geometry} material={material} scale={[radius, length, radius]} frustumCulled={false} renderOrder={3} />;
}

export function LaunchVehicle({ flight, env, hot }: { flight: FlightState; env: THREE.Texture | null; hot: boolean }) {
  const geo = useStackGeometry();
  const coreMap = useMemo(() => createCoreTexture(), []);
  const boosterMap = useMemo(() => createBoosterTexture(), []);
  const glowMap = useMemo(() => createGlowTexture(), []);
  const paint = useMemo(() => ({
    core: new THREE.MeshStandardMaterial({ color: '#ffffff', map: coreMap ?? undefined, roughness: 0.46, metalness: 0.05 }),
    booster: new THREE.MeshStandardMaterial({ color: '#ffffff', map: boosterMap ?? undefined, roughness: 0.5, metalness: 0.05 }),
    white: new THREE.MeshStandardMaterial({ color: '#f1eee7', roughness: 0.44, metalness: 0.05 }),
    panel: new THREE.MeshStandardMaterial({ color: '#f1eee7', roughness: 0.44, metalness: 0.05, side: THREE.DoubleSide }),
  }), [coreMap, boosterMap]);
  const plumeGeometry = useMemo(() => {
    const g = new THREE.CylinderGeometry(1, 2.1, 1, 32, 1, true);
    g.translate(0, -0.5, 0);
    return g;
  }, []);
  // Solid-booster flame: wider at the tail, with a second, larger shell of glowing exhaust.
  const flareGeometry = useMemo(() => {
    const g = new THREE.CylinderGeometry(1, 3.4, 1, 32, 1, true);
    g.translate(0, -0.5, 0);
    return g;
  }, []);
  const plumes = useMemo(() => ({
    core: createPlumeMaterial('hydrogen', 0),
    boosters: [createPlumeMaterial('solid', 1), createPlumeMaterial('solid', 2)],
    upper: createPlumeMaterial('hydrogen', 3),
  }), []);
  useEffect(() => {
    Object.values(paint).forEach((material) => { material.envMap = env; material.needsUpdate = true; });
    for (const material of [steel, darkBand, windowGlass]) { material.envMap = env; material.needsUpdate = true; }
  }, [paint, env]);
  useEffect(() => () => {
    Object.values(paint).forEach((material) => material.dispose());
    coreMap?.dispose(); boosterMap?.dispose(); glowMap?.dispose(); plumeGeometry.dispose(); flareGeometry.dispose();
    plumes.core.dispose(); plumes.upper.dispose(); plumes.boosters.forEach((material) => material.dispose());
  }, [paint, coreMap, boosterMap, glowMap, plumeGeometry, flareGeometry, plumes]);

  const lower = useRef<THREE.Group>(null);
  const boosters = useRef<(THREE.Group | null)[]>([]);
  const boosterPlumes = useRef<(THREE.Group | null)[]>([]);
  const corePlume = useRef<THREE.Group>(null);
  const upperPlume = useRef<THREE.Group>(null);
  const abort = useRef<THREE.Group>(null);
  const abortFlash = useRef<THREE.Mesh>(null);
  const panels = useRef<(THREE.Group | null)[]>([]);
  const glow = useRef<THREE.Sprite>(null);
  const light = useRef<THREE.PointLight>(null);
  const sepFlash = useRef<(THREE.Mesh | null)[]>([]);

  useFrame(({ clock }) => {
    const time = clock.getElapsedTime();
    const flicker = 0.9 + Math.sin(time * 37) * 0.05 + Math.sin(time * 19) * 0.05;
    const w = flight.spread;
    const set = (material: THREE.ShaderMaterial, throttle: number) => {
      material.uniforms.uTime.value = time;
      material.uniforms.uThrottle.value = throttle;
      material.uniforms.uClipY.value = flight.clipY;
    };
    set(plumes.core, flight.core);
    plumes.boosters.forEach((material) => set(material, flight.boosters));
    set(plumes.upper, flight.upper);
    if (corePlume.current) {
      corePlume.current.visible = flight.core > 0.03;
      corePlume.current.scale.set(w, (0.5 + flight.core * 0.6) * flicker * (1 + (w - 1) * 0.5), w);
    }
    boosterPlumes.current.forEach((group) => {
      if (!group) return;
      group.visible = flight.boosters > 0.03;
      group.scale.set(w, (0.35 + flight.boosters * 0.75) * flicker * (1 + (w - 1) * 0.35), w);
    });
    if (upperPlume.current) {
      upperPlume.current.visible = flight.upper > 0.03;
      upperPlume.current.scale.set(1, (0.5 + flight.upper * 0.6) * flicker, 1);
    }

    // Booster separation: both fall behind and tip outward; small motors push them clear.
    const tb = flight.sinceBoosterSep;
    boosters.current.forEach((group, index) => {
      if (!group) return;
      const side = index === 0 ? 1 : -1;
      if (tb <= 0) { group.position.set(side * STACK.boosterOffset, 0, 0); group.rotation.set(0, 0, 0); group.visible = true; return; }
      group.visible = tb < 4.2;
      group.position.set(side * (STACK.boosterOffset + tb * 9 + tb * tb * 5), -tb * tb * 26, 0);
      group.rotation.set(tb * 0.12, 0, -side * tb * 0.2);
    });
    sepFlash.current.forEach((mesh) => { if (mesh) mesh.visible = tb > 0 && tb < 0.4; });
    flash.opacity = tb > 0 && tb < 0.4 ? (1 - tb / 0.4) * 0.9 : 0;

    // Abort tower and the service-module panels leave once the air is thin enough.
    const ta = flight.sinceAbortJettison;
    if (abort.current) {
      abort.current.visible = ta < 2.6;
      abort.current.position.set(ta > 0 ? ta * 5 : 0, ta > 0 ? ta * 55 + ta * ta * 150 : 0, 0);
      abort.current.rotation.z = ta > 0 ? -ta * 0.1 : 0;
    }
    if (abortFlash.current) {
      abortFlash.current.visible = ta > 0 && ta < 0.9;
      (abortFlash.current.material as THREE.MeshBasicMaterial).opacity = ta > 0 ? Math.max(0, 1 - ta / 0.9) * 0.85 : 0;
    }
    panels.current.forEach((group, index) => {
      if (!group) return;
      const angle = (index / 3) * Math.PI * 2 + Math.PI / 3;
      if (ta <= 0) { group.position.set(0, 0, 0); group.rotation.set(0, 0, 0); group.visible = true; return; }
      group.visible = ta < 3;
      const out = ta * 10 + ta * ta * 4;
      group.position.set(Math.sin(angle) * out, -ta * ta * 20, Math.cos(angle) * out);
      group.rotation.set(Math.cos(angle) * ta * 0.7, 0, -Math.sin(angle) * ta * 0.7);
    });

    // Stage separation: the spent core drops away from the upper stage.
    const ts = flight.sinceStageSep;
    if (lower.current) {
      lower.current.visible = ts < 6;
      lower.current.position.set(0, ts > 0 ? -(ts * 5 + ts * ts * 7) : 0, 0);
      lower.current.rotation.z = ts > 0 ? ts * 0.02 : 0;
    }

    const brightest = Math.max(flight.boosters, flight.core * 0.45, flight.upper * 0.25);
    if (glow.current) {
      const size = (22 + brightest * 62) * flicker * (ts > 0 ? 0.4 : 1);
      glow.current.scale.set(size, size, 1);
      glow.current.position.y = ts > 0 ? 64 : -6;
      (glow.current.material as THREE.SpriteMaterial).opacity = Math.min(1, brightest * 1.3);
    }
    if (light.current) light.current.intensity = Math.max(flight.boosters, flight.core * 0.1) * 5200 * flicker;
    engineMetal.emissiveIntensity = hot ? Math.max(flight.core, flight.boosters) * 0.55 : 0;
    const envIntensity = 0.25 + 0.95 * flight.sky;
    Object.values(paint).forEach((material) => { material.envMapIntensity = envIntensity; });
    steel.envMapIntensity = envIntensity;
  });

  return (
    <group>
      {/* Core stage with its engines, and the adapter that tapers to the upper stage. */}
      <group ref={lower}>
        <mesh geometry={geo.core} material={paint.core} castShadow receiveShadow />
        <mesh geometry={geo.coreSkirt} material={darkBand} castShadow />
        <mesh geometry={geo.adapter} material={paint.white} castShadow />
        <mesh position={[0, 65.0, 0]} material={darkBand}><cylinderGeometry args={[4.23, 4.23, 0.8, 64, 1, true]} /></mesh>
        <mesh position={[0, 1.9, 0]} material={darkBand}><cylinderGeometry args={[3.5, 3.5, 0.7, 48]} /></mesh>
        {CORE_ENGINES.map(([x, z]) => (
          <mesh key={`${x}:${z}`} position={[x, 1.7, z]} geometry={geo.coreBell} material={engineMetal} />
        ))}
        <group ref={corePlume} position={[0, -1.2, 0]}>
          {CORE_ENGINES.map(([x, z]) => (
            <group key={`${x}:${z}`} position={[x, 0, z]}><Plume material={plumes.core} geometry={plumeGeometry} radius={1.0} length={36} /></group>
          ))}
        </group>
      </group>

      {/* Solid boosters. */}
      {[1, -1].map((side, index) => (
        <group key={side} ref={(node) => { boosters.current[index] = node; }} position={[side * STACK.boosterOffset, 0, 0]}>
          <mesh geometry={geo.booster} material={paint.booster} castShadow receiveShadow />
          <mesh geometry={geo.boosterSkirt} material={paint.white} castShadow />
          <mesh geometry={geo.boosterNose} material={paint.white} castShadow />
          <mesh position={[0, -0.1, 0]} geometry={geo.boosterBell} material={engineMetal} />
          {[5.2, 46.2].map((y) => (
            <mesh key={y} position={[-side * 1.2, y, 0]} rotation={[0, 0, Math.PI / 2]} material={steel}><cylinderGeometry args={[0.16, 0.16, 2.5, 8]} /></mesh>
          ))}
          <group ref={(node) => { boosterPlumes.current[index] = node; }} position={[0, -2.6, 0]}>
            <Plume material={plumes.boosters[index]} geometry={flareGeometry} radius={1.75} length={165} />
            <Plume material={plumes.boosters[index]} geometry={flareGeometry} radius={2.9} length={118} />
          </group>
          {[2.4, 50.5].map((y, i) => (
            <mesh key={y} ref={(node) => { sepFlash.current[index * 2 + i] = node; }} position={[side * 2.4, y, 0]} material={flash} visible={false}>
              <sphereGeometry args={[3.2, 12, 8]} />
            </mesh>
          ))}
        </group>
      ))}

      {/* Upper stage, service module and capsule: this part goes to Mars. */}
      <group>
        <mesh position={[0, 75, 0]} material={paint.white} castShadow><cylinderGeometry args={[2.56, 2.56, 6, 48]} /></mesh>
        <mesh position={[0, 78.6, 0]} material={darkBand}><cylinderGeometry args={[3.3, 2.56, 1.2, 48]} /></mesh>
        <mesh position={[0, 72, 0]} geometry={geo.upperBell} material={engineMetal} />
        <group ref={upperPlume} position={[0, 69.2, 0]} visible={false}>
          <Plume material={plumes.upper} geometry={plumeGeometry} radius={1.2} length={46} />
        </group>
        <group position={[0, STACK.capsuleBase, 0]} rotation={[Math.PI / 2, 0, 0]}>
          <Aeroshell heat={ZERO} cruiseOffset={ZERO} showCruise arrays={false} />
        </group>
        {[0, 1, 2].map((index) => (
          <group key={index} ref={(node) => { panels.current[index] = node; }}>
            <mesh position={[0, 82.1, 0]} rotation={[0, (index / 3) * Math.PI * 2, 0]} geometry={geo.panel} material={paint.panel} castShadow />
          </group>
        ))}
      </group>

      {/* Launch abort system: a fairing over the capsule and a tower of escape motors. */}
      <group ref={abort}>
        <mesh geometry={geo.fairing} material={paint.panel} castShadow />
        <mesh geometry={geo.tower} material={paint.white} castShadow />
        <mesh position={[0, 95.2, 0]} material={darkBand}><cylinderGeometry args={[0.88, 0.88, 0.5, 24, 1, true]} /></mesh>
        {/* Crew hatch and window, on the side that faces the access arm (north, −z). */}
        <mesh position={[0, STACK.hatchY, -fairingRadius(STACK.hatchY) + 0.02]} rotation={[-0.06, 0, 0]} material={darkBand}><boxGeometry args={[1.05, 1.15, 0.08]} /></mesh>
        <mesh position={[0, STACK.hatchY + 0.12, -fairingRadius(STACK.hatchY + 0.12) - 0.03]} rotation={[-0.06, 0, 0]} material={windowGlass}><circleGeometry args={[0.2, 20]} /></mesh>
        {[1.25, -1.25].map((x) => (
          <mesh key={x} position={[x, 87.9, -Math.sqrt(Math.max(0.1, fairingRadius(87.9) ** 2 - x * x)) - 0.03]} rotation={[-0.3, x > 0 ? -0.42 : 0.42, 0]} material={windowGlass}><circleGeometry args={[0.17, 16]} /></mesh>
        ))}
        <mesh ref={abortFlash} position={[0, 93.2, 0]} visible={false}>
          <coneGeometry args={[3.4, 14, 20, 1, true]} />
          <meshBasicMaterial color="#ffd9a0" transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      </group>

      <sprite ref={glow} position={[0, -6, 0]} renderOrder={3}>
        <spriteMaterial map={glowMap ?? undefined} transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
      </sprite>
      <pointLight ref={light} position={[0, -14, 0]} color="#ffb265" intensity={0} distance={600} decay={1.5} />
    </group>
  );
}
