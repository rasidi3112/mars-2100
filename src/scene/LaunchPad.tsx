import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LAUNCH_STORY } from '../mission/launch';
import { STACK, fairingRadius } from './LaunchVehicle';
import type { Signal } from './Vehicles';

// The launch pad, in metres. x is east, z is south, y is up; the rocket stands at the origin.
//
// The pad sits where NASA's Launch Complex 39B is, and its parts are the ones a crewed launch
// uses there: a raised hardstand over a flame trench, a mobile launcher with a tower, a crew
// access arm ending in a White Room, umbilical arms, three lightning towers, a water tower for
// sound suppression and propellant spheres. Shapes and sizes are approximate, and the design is
// a stand-in, not a model of the real structures.

export const DECK_Y = 26.3; // top of the launch platform: the rocket's base
const MOUND_Y = 12;
const TOWER_Z = -30;
const TOWER_HALF = 6;
const TOWER_HEIGHT = 108;
export const ARM_Y = DECK_Y + STACK.hatchY - 1.05; // walkway floor, just below the hatch sill
const ARM_HINGE: [number, number, number] = [2.6, ARM_Y, TOWER_Z + TOWER_HALF - 0.5];
const ARM_LENGTH = 16.4;

function box(w: number, h: number, d: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rx || ry || rz) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz)));
  g.translate(x, y, z);
  return g;
}

function merged(parts: THREE.BufferGeometry[]) {
  const out = mergeGeometries(parts, false);
  parts.forEach((part) => part.dispose());
  return out;
}

const steelGrey = new THREE.MeshStandardMaterial({ color: '#8f979e', roughness: 0.55, metalness: 0.55 });
const steelDark = new THREE.MeshStandardMaterial({ color: '#4c5258', roughness: 0.6, metalness: 0.5 });
const paintWhite = new THREE.MeshStandardMaterial({ color: '#eceae4', roughness: 0.6, metalness: 0.05 });
const safetyRed = new THREE.MeshStandardMaterial({ color: '#b5402c', roughness: 0.6, metalness: 0.3 });
const concrete = new THREE.MeshStandardMaterial({ color: '#a7a299', roughness: 0.95, metalness: 0 });
const scorched = new THREE.MeshStandardMaterial({ color: '#34322f', roughness: 0.9, metalness: 0.05 });
const gravel = new THREE.MeshStandardMaterial({ color: '#b3a88f', roughness: 1, metalness: 0 });
const buildingMat = new THREE.MeshStandardMaterial({ color: '#cfccc4', roughness: 0.85, metalness: 0.05 });
const doorMat = new THREE.MeshStandardMaterial({ color: '#3b4046', roughness: 0.6, metalness: 0.3 });
const glass = new THREE.MeshStandardMaterial({ color: '#9fc0d6', roughness: 0.1, metalness: 0.2, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });

// ---------- crew ----------

const suitOrange = new THREE.MeshStandardMaterial({ color: '#e2661c', roughness: 0.78, metalness: 0 });
const suitBlue = new THREE.MeshStandardMaterial({ color: '#1f3f73', roughness: 0.7, metalness: 0.05 });
const suitWhite = new THREE.MeshStandardMaterial({ color: '#f0eee8', roughness: 0.7, metalness: 0 });
const bootDark = new THREE.MeshStandardMaterial({ color: '#1c1e22', roughness: 0.7, metalness: 0.1 });
const helmetWhite = new THREE.MeshStandardMaterial({ color: '#f4f2ec', roughness: 0.35, metalness: 0.1 });
const visorDark = new THREE.MeshStandardMaterial({ color: '#10161d', roughness: 0.1, metalness: 0.8 });
const skin = new THREE.MeshStandardMaterial({ color: '#c99a78', roughness: 0.8, metalness: 0 });

interface FigurePose { stride: number; visible: boolean; x: number; z: number; heading: number; wave: number }

// A person about 1.8 m tall, facing +z. Flight crew wear orange pressure suits with a white
// helmet (visor open); the closeout crew wear white coveralls and a cap.
function Figure({ pose, suit }: { pose: FigurePose; suit: 'flight' | 'closeout' }) {
  const root = useRef<THREE.Group>(null);
  const legs = useRef<(THREE.Group | null)[]>([]);
  const knees = useRef<(THREE.Group | null)[]>([]);
  const arms = useRef<(THREE.Group | null)[]>([]);
  const body = suit === 'flight' ? suitOrange : suitWhite;
  useFrame(() => {
    const group = root.current;
    if (!group) return;
    group.visible = pose.visible;
    if (!pose.visible) return;
    const swing = Math.sin(pose.stride);
    const moving = pose.stride !== 0;
    group.position.set(pose.x, moving ? Math.abs(Math.cos(pose.stride)) * 0.035 : 0, pose.z);
    group.rotation.y = pose.heading;
    legs.current.forEach((leg, i) => { if (leg) leg.rotation.x = (i === 0 ? swing : -swing) * 0.48; });
    knees.current.forEach((knee, i) => { if (knee) knee.rotation.x = Math.max(0, i === 0 ? -swing : swing) * 0.7; });
    arms.current.forEach((arm, i) => {
      if (!arm) return;
      arm.rotation.x = (i === 0 ? -swing : swing) * 0.38;
      arm.rotation.z = i === 0 ? -0.08 : 0.08;
      if (i === 0 && pose.wave > 0) { arm.rotation.x = -2.6 + Math.sin(pose.wave * 7) * 0.25; arm.rotation.z = -0.35; }
    });
  });
  return (
    <group ref={root}>
      {/* Legs: hip → knee → boot. */}
      {[-0.11, 0.11].map((x, i) => (
        <group key={x} ref={(node) => { legs.current[i] = node; }} position={[x, 0.92, 0]}>
          <mesh position={[0, -0.22, 0]} material={body} castShadow><capsuleGeometry args={[0.085, 0.3, 3, 8]} /></mesh>
          <group ref={(node) => { knees.current[i] = node; }} position={[0, -0.46, 0]}>
            <mesh position={[0, -0.2, 0]} material={body} castShadow><capsuleGeometry args={[0.075, 0.28, 3, 8]} /></mesh>
            <mesh position={[0, -0.41, 0.045]} material={bootDark} castShadow><boxGeometry args={[0.13, 0.11, 0.27]} /></mesh>
          </group>
        </group>
      ))}
      {/* Torso, with the harness of a pressure suit. */}
      <mesh position={[0, 1.2, 0]} material={body} castShadow><capsuleGeometry args={[0.185, 0.3, 4, 10]} /></mesh>
      <mesh position={[0, 0.96, 0]} material={body}><sphereGeometry args={[0.18, 10, 8]} /></mesh>
      {suit === 'flight' && (
        <>
          <mesh position={[0, 1.24, 0.172]} material={suitBlue}><boxGeometry args={[0.2, 0.2, 0.05]} /></mesh>
          <mesh position={[0, 1.02, 0]} material={suitBlue}><cylinderGeometry args={[0.192, 0.192, 0.05, 14]} /></mesh>
          <mesh position={[0, 1.47, 0]} material={steelGrey}><cylinderGeometry args={[0.135, 0.15, 0.05, 16]} /></mesh>
        </>
      )}
      {/* Arms: shoulder → glove. */}
      {[-0.245, 0.245].map((x, i) => (
        <group key={x} ref={(node) => { arms.current[i] = node; }} position={[x, 1.4, 0]}>
          <mesh position={[0, -0.26, 0]} material={body} castShadow><capsuleGeometry args={[0.062, 0.42, 3, 8]} /></mesh>
          <mesh position={[0, -0.55, 0]} material={suit === 'flight' ? suitBlue : skin}><sphereGeometry args={[0.062, 8, 6]} /></mesh>
        </group>
      ))}
      {/* Head. */}
      {suit === 'flight' ? (
        <>
          <mesh position={[0, 1.61, 0]} material={helmetWhite} castShadow><sphereGeometry args={[0.158, 18, 14]} /></mesh>
          <mesh position={[0, 1.615, 0.068]} material={visorDark}><sphereGeometry args={[0.118, 14, 10]} /></mesh>
        </>
      ) : (
        <>
          <mesh position={[0, 1.6, 0]} material={skin} castShadow><sphereGeometry args={[0.115, 14, 10]} /></mesh>
          <mesh position={[0, 1.67, -0.01]} material={suitWhite}><sphereGeometry args={[0.122, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
        </>
      )}
    </group>
  );
}

const WALK_SPEED = 1.7; // metres per second, a brisk walk
const WALK_GAP = 1.6;

// Four flight crew walk the arm in single file and step into the White Room; two closeout crew
// wait at its door. Positions are in the arm's own frame (the arm group turns when it retracts).
function Crew({ story }: { story: Signal }) {
  const flight = useMemo<FigurePose[]>(() => Array.from({ length: 4 }, () => ({ stride: 0, visible: true, x: 0, z: 0, heading: 0, wave: 0 })), []);
  const closeout = useMemo<FigurePose[]>(() => [
    { stride: 0, visible: true, x: -3.5, z: 14.9, heading: Math.PI * 0.62, wave: 0 },
    { stride: 0, visible: true, x: -1.7, z: 15.3, heading: -Math.PI * 0.62, wave: 0 },
  ], []);
  useFrame(() => {
    const s = story.current;
    const boarding = s < LAUNCH_STORY.armRetract;
    flight.forEach((pose, i) => {
      // The leader reaches the door about 3.5 s in; each crew member follows WALK_GAP behind.
      const z = 16.2 - (3.5 - s) * WALK_SPEED - i * WALK_GAP;
      pose.visible = boarding && z < 17.6;
      pose.x = -2.6 + (i % 2 === 0 ? 0.05 : -0.05);
      pose.z = Math.max(1.2, z);
      pose.stride = z < 1.2 ? 0 : (z / 1.44) * Math.PI * 2;
      // The last one turns for a wave before stepping in.
      pose.wave = i === 3 && z > 14.4 && z < 16.2 ? s : 0;
      pose.heading = pose.wave > 0 ? Math.PI * 0.42 : 0;
    });
    closeout.forEach((pose) => { pose.visible = boarding; });
  });
  return (
    <group>
      {flight.map((pose, i) => <Figure key={i} pose={pose} suit="flight" />)}
      {closeout.map((pose, i) => <Figure key={i} pose={pose} suit="closeout" />)}
    </group>
  );
}

// ---------- crew access arm ----------

function useArmGeometry() {
  return useMemo(() => {
    const cx = -2.6;
    const L = ARM_LENGTH;
    const frame: THREE.BufferGeometry[] = [box(2.8, 0.22, L, cx, -0.11, L / 2)];
    // Truss under the walkway, posts and a roof over it. The sides stay open behind glass.
    for (const side of [-1.35, 1.35]) {
      frame.push(box(0.2, 0.2, L, cx + side, -1.5, L / 2), box(0.12, 0.12, L, cx + side, 1.1, L / 2), box(0.16, 0.16, L, cx + side, 2.65, L / 2));
      for (let z = 0; z <= L + 0.01; z += L / 8) frame.push(box(0.14, 4.3, 0.14, cx + side, 0.6, Math.min(z, L - 0.07)));
      for (let i = 0; i < 8; i += 1) frame.push(box(0.1, 0.1, Math.hypot(L / 8, 1.4), cx + side, -0.8, (i + 0.5) * (L / 8), (i % 2 ? 1 : -1) * Math.atan2(1.4, L / 8)));
    }
    const roof = box(3.0, 0.1, L, cx, 2.75, L / 2);
    return { frame: merged(frame), roof };
  }, []);
}

function CrewAccessArm({ story }: { story: Signal }) {
  const arm = useRef<THREE.Group>(null);
  const geo = useArmGeometry();
  useEffect(() => () => { geo.frame.dispose(); geo.roof.dispose(); }, [geo]);
  useFrame(() => {
    if (!arm.current) return;
    // Retracts at T−8 minutes: it swings away from the capsule toward the east.
    const k = THREE.MathUtils.smootherstep(story.current, LAUNCH_STORY.armRetract + 0.3, LAUNCH_STORY.countdown - 0.2);
    arm.current.rotation.y = k * 1.25;
  });
  const roomZ = ARM_LENGTH + 2.1;
  const reach = -(ARM_HINGE[2] + ARM_LENGTH + 4.2) - fairingRadius(STACK.hatchY);
  return (
    <group ref={arm} position={ARM_HINGE}>
      <mesh geometry={geo.frame} material={steelGrey} castShadow />
      <mesh geometry={geo.roof} material={paintWhite} castShadow />
      {[-1.36, 1.36].map((side) => (
        <mesh key={side} position={[-2.6 + side, 1.25, ARM_LENGTH / 2]} material={glass}><boxGeometry args={[0.03, 2.7, ARM_LENGTH - 0.3]} /></mesh>
      ))}
      {/* White Room: the last stop before the hatch. Open toward the arm, sealed toward the capsule. */}
      <group position={[-2.6, 0, roomZ]}>
        <mesh position={[0, -0.11, 0]} material={paintWhite} castShadow><boxGeometry args={[4.4, 0.22, 4.2]} /></mesh>
        <mesh position={[0, 3.2, 0]} material={paintWhite} castShadow><boxGeometry args={[4.4, 0.16, 4.2]} /></mesh>
        {[-2.14, 2.14].map((x) => <mesh key={x} position={[x, 1.55, 0]} material={paintWhite} castShadow><boxGeometry args={[0.12, 3.2, 4.2]} /></mesh>)}
        {[-1.55, 1.55].map((x) => <mesh key={x} position={[x, 1.55, -2.04]} material={paintWhite}><boxGeometry args={[1.3, 3.2, 0.12]} /></mesh>)}
        <mesh position={[0, 2.75, -2.04]} material={paintWhite}><boxGeometry args={[1.8, 0.8, 0.12]} /></mesh>
        <mesh position={[0, 1.55, 2.04]} material={paintWhite}><boxGeometry args={[4.4, 3.2, 0.12]} /></mesh>
        {/* Soft seal bridging the gap to the hatch. */}
        <mesh position={[0, 1.2, 2.1 + reach / 2]} material={steelDark}><boxGeometry args={[1.7, 2.0, Math.max(0.2, reach)]} /></mesh>
        <mesh position={[0, -1.6, 0]} material={steelGrey}><boxGeometry args={[0.3, 2.8, 3.6]} /></mesh>
      </group>
      <Crew story={story} />
    </group>
  );
}

// ---------- mobile launcher ----------

function useLauncherGeometry() {
  return useMemo(() => {
    const h = TOWER_HALF;
    const levels = 18;
    const step = TOWER_HEIGHT / levels;
    const lattice: THREE.BufferGeometry[] = [];
    for (const [x, z] of [[-h, -h], [h, -h], [-h, h], [h, h]]) lattice.push(box(0.9, TOWER_HEIGHT, 0.9, x, TOWER_HEIGHT / 2, z));
    const diagonal = Math.hypot(2 * h, step);
    const slope = Math.atan2(step, 2 * h);
    for (let i = 0; i <= levels; i += 1) {
      const y = i * step;
      lattice.push(box(2 * h, 0.4, 0.4, 0, y, -h), box(2 * h, 0.4, 0.4, 0, y, h), box(0.4, 0.4, 2 * h, -h, y, 0), box(0.4, 0.4, 2 * h, h, y, 0));
      if (i === levels) continue;
      const flip = i % 2 ? 1 : -1;
      lattice.push(
        box(diagonal, 0.26, 0.26, 0, y + step / 2, -h, 0, 0, flip * slope), box(diagonal, 0.26, 0.26, 0, y + step / 2, h, 0, 0, -flip * slope),
        box(0.26, 0.26, diagonal, -h, y + step / 2, 0, flip * slope), box(0.26, 0.26, diagonal, h, y + step / 2, 0, -flip * slope),
      );
    }
    const floors: THREE.BufferGeometry[] = [];
    for (let i = 1; i <= levels; i += 1) floors.push(box(2 * h - 0.6, 0.14, 2 * h - 0.6, 0, i * step, 0));
    floors.push(box(4.2, TOWER_HEIGHT, 4.2, 1.6, TOWER_HEIGHT / 2, -1.4)); // elevator shaft
    return { lattice: merged(lattice), floors: merged(floors) };
  }, []);
}

// Umbilical arms: they feed propellant, power and air to the rocket and swing clear at liftoff.
const UMBILICALS: { y: number; reach: number; size: number }[] = [
  { y: 30, reach: 4.3, size: 1.5 }, { y: 50, reach: 4.3, size: 1.2 }, { y: 62.5, reach: 4.3, size: 1.5 }, { y: 75, reach: 2.7, size: 1.2 }, { y: 81.5, reach: 3.5, size: 1.0 },
];

function MobileLauncher({ story }: { story: Signal }) {
  const geo = useLauncherGeometry();
  const arms = useRef<(THREE.Group | null)[]>([]);
  useEffect(() => () => { geo.lattice.dispose(); geo.floors.dispose(); }, [geo]);
  useFrame(() => {
    const k = THREE.MathUtils.smoothstep(story.current, LAUNCH_STORY.liftoff - 0.15, LAUNCH_STORY.liftoff + 1.1);
    arms.current.forEach((group, i) => { if (group) group.rotation.y = (i % 2 ? 1 : -1) * k * 1.15; });
  });
  const face = TOWER_Z + TOWER_HALF;
  return (
    <group>
      {/* Platform on its mount pedestals, over the flame trench. */}
      <mesh position={[0, DECK_Y - 3.8, -13]} material={steelGrey} castShadow receiveShadow><boxGeometry args={[50, 7.6, 58]} /></mesh>
      <mesh position={[0, DECK_Y + 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} material={scorched}><circleGeometry args={[9.5, 32]} /></mesh>
      {[[-21, -38], [21, -38], [-21, -13], [21, -13], [-21, 12], [21, 12]].map(([x, z]) => (
        <mesh key={`${x}:${z}`} position={[x, MOUND_Y + 3.35, z]} material={steelDark} castShadow><boxGeometry args={[4, 6.7, 4]} /></mesh>
      ))}
      {/* Tail service masts beside the engine section. */}
      {[-8.5, 8.5].map((x) => (
        <mesh key={x} position={[x, DECK_Y + 4.5, -8]} material={steelGrey} castShadow><boxGeometry args={[3, 9, 3.4]} /></mesh>
      ))}
      <group position={[0, DECK_Y, TOWER_Z]}>
        <mesh geometry={geo.lattice} material={steelGrey} castShadow />
        <mesh geometry={geo.floors} material={steelDark} />
        <mesh position={[0, TOWER_HEIGHT + 4, 0]} material={safetyRed}><boxGeometry args={[5, 8, 5]} /></mesh>
        <mesh position={[0, TOWER_HEIGHT + 13, 0]} material={steelGrey}><cylinderGeometry args={[0.12, 0.3, 10, 6]} /></mesh>
      </group>
      {UMBILICALS.map((arm, i) => {
        const length = -face - arm.reach;
        return (
          <group key={arm.y} ref={(node) => { arms.current[i] = node; }} position={[i % 2 ? 3.4 : -3.4, DECK_Y + arm.y, face]}>
            <mesh position={[i % 2 ? -3.4 : 3.4, 0, length / 2]} material={steelGrey} castShadow><boxGeometry args={[arm.size * 1.5, arm.size, length]} /></mesh>
            <mesh position={[i % 2 ? -3.4 : 3.4, 0, length - 0.5]} material={steelDark}><boxGeometry args={[arm.size * 2.1, arm.size * 1.5, 1]} /></mesh>
          </group>
        );
      })}
      <CrewAccessArm story={story} />
    </group>
  );
}

// ---------- pad surface ----------

function createConcreteTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = '#aaa59c';
  ctx.fillRect(0, 0, size, size);
  let seed = 4711;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 5200; i += 1) {
    const shade = 140 + Math.floor(rand() * 60);
    ctx.fillStyle = `rgba(${shade},${shade - 4},${shade - 12},0.2)`;
    ctx.fillRect(rand() * size, rand() * size, 2 + rand() * 12, 1 + rand() * 5);
  }
  ctx.strokeStyle = 'rgba(70,68,64,0.35)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= size; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(size, i); ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(5, 5);
  texture.anisotropy = 8;
  return texture;
}

function PadSurface() {
  const texture = useMemo(() => createConcreteTexture(), []);
  const surface = useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', map: texture ?? undefined, roughness: 0.95, metalness: 0 }), [texture]);
  useEffect(() => () => { texture?.dispose(); surface.dispose(); }, [texture, surface]);
  return (
    <group>
      {/* Raised hardstand. */}
      <mesh position={[0, MOUND_Y / 2, 0]} rotation={[0, Math.PI / 8, 0]} material={surface} receiveShadow>
        <cylinderGeometry args={[92, 178, MOUND_Y, 8]} />
      </mesh>
      {/* Flame trench, running north–south under the platform, and its deflector. */}
      <mesh position={[0, MOUND_Y + 0.04, 0]} material={scorched} receiveShadow><boxGeometry args={[18, 0.08, 172]} /></mesh>
      {[-10.2, 10.2].map((x) => <mesh key={x} position={[x, MOUND_Y + 0.9, 0]} material={concrete} castShadow><boxGeometry args={[2.4, 1.8, 172]} /></mesh>)}
      <mesh position={[0, MOUND_Y + 3.2, 0]} rotation={[0, 0, Math.PI / 4]} material={steelDark}><boxGeometry args={[7, 7, 17]} /></mesh>
      {/* Crawlerway ramp from the south. */}
      <mesh position={[0, MOUND_Y / 2 - 0.2, 186]} rotation={[Math.atan2(MOUND_Y, 200), 0, 0]} material={gravel} receiveShadow><boxGeometry args={[42, 0.6, 201]} /></mesh>
    </group>
  );
}

// ---------- the rest of the site ----------

const LIGHTNING: [number, number][] = [[165, -110], [-190, -70], [150, 150]];

function useLightningGeometry() {
  return useMemo(() => {
    const mast: THREE.BufferGeometry[] = [];
    const height = 150;
    const legs: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    const sections = 10;
    for (let i = 0; i < sections; i += 1) {
      const y0 = (i / sections) * height;
      const y1 = ((i + 1) / sections) * height;
      const w0 = 9 - (7.4 * i) / sections;
      const w1 = 9 - (7.4 * (i + 1)) / sections;
      for (const [sx, sz] of legs) {
        const lean = Math.atan2(w0 - w1, y1 - y0);
        mast.push(box(0.5, y1 - y0 + 0.3, 0.5, (sx * (w0 + w1)) / 2, (y0 + y1) / 2, (sz * (w0 + w1)) / 2, sz * lean, 0, -sx * lean));
      }
      mast.push(box(2 * w1, 0.3, 0.3, 0, y1, -w1), box(2 * w1, 0.3, 0.3, 0, y1, w1), box(0.3, 0.3, 2 * w1, -w1, y1, 0), box(0.3, 0.3, 2 * w1, w1, y1, 0));
      const d = Math.hypot(w0 + w1, y1 - y0);
      const a = Math.atan2(y1 - y0, w0 + w1);
      mast.push(box(d, 0.2, 0.2, 0, (y0 + y1) / 2, -(w0 + w1) / 2, 0, 0, i % 2 ? a : -a), box(0.2, 0.2, d, (w0 + w1) / 2, (y0 + y1) / 2, 0, i % 2 ? a : -a));
    }
    // Catenary wires between the mast tops and down to the ground.
    const wires: number[] = [];
    const top = 181;
    const sag = (a: THREE.Vector3, b: THREE.Vector3, drop: number) => {
      const steps = 14;
      for (let i = 0; i < steps; i += 1) {
        for (const t of [i / steps, (i + 1) / steps]) {
          const p = a.clone().lerp(b, t);
          p.y -= Math.sin(t * Math.PI) * drop;
          wires.push(p.x, p.y, p.z);
        }
      }
    };
    LIGHTNING.forEach(([x, z], i) => {
      const [nx, nz] = LIGHTNING[(i + 1) % LIGHTNING.length];
      sag(new THREE.Vector3(x, top, z), new THREE.Vector3(nx, top, nz), 16);
      const out = new THREE.Vector3(x, 0, z).normalize().multiplyScalar(170);
      sag(new THREE.Vector3(x, top, z), new THREE.Vector3(x + out.x, 0, z + out.z), 6);
    });
    const wireGeometry = new THREE.BufferGeometry();
    wireGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wires, 3));
    return { mast: merged(mast), wires: wireGeometry };
  }, []);
}

function SiteStructures() {
  const lightning = useLightningGeometry();
  useEffect(() => () => { lightning.mast.dispose(); lightning.wires.dispose(); }, [lightning]);
  return (
    <group>
      {LIGHTNING.map(([x, z]) => (
        <group key={`${x}:${z}`} position={[x, 0, z]}>
          <mesh geometry={lightning.mast} material={steelGrey} castShadow />
          <mesh position={[0, 165.5, 0]} material={paintWhite}><cylinderGeometry args={[0.35, 0.8, 31, 8]} /></mesh>
        </group>
      ))}
      <lineSegments geometry={lightning.wires}>
        <lineBasicMaterial color="#5d646b" transparent opacity={0.7} />
      </lineSegments>
      {/* Water tower: its water floods the pad at ignition to damp the sound. */}
      <group position={[125, 0, -150]}>
        <mesh position={[0, 38, 0]} material={paintWhite} castShadow><cylinderGeometry args={[2.6, 4.2, 76, 16]} /></mesh>
        <mesh position={[0, 80, 0]} scale={[1, 0.62, 1]} material={paintWhite} castShadow><sphereGeometry args={[13, 28, 18]} /></mesh>
      </group>
      {/* Liquid hydrogen and liquid oxygen storage spheres. */}
      {[[285, -250], [-300, -235]].map(([x, z]) => (
        <group key={`${x}:${z}`} position={[x, 0, z]}>
          <mesh position={[0, 16, 0]} material={paintWhite} castShadow><sphereGeometry args={[12.5, 28, 18]} /></mesh>
          <mesh position={[0, 4, 0]} material={steelGrey}><cylinderGeometry args={[6, 8, 8, 12]} /></mesh>
        </group>
      ))}
      {/* The assembly building and launch control, about 5 km to the south-west. */}
      <group position={[-2960, 0, 4570]}>
        <mesh position={[0, 80, 0]} material={buildingMat}><boxGeometry args={[158, 160, 218]} /></mesh>
        {[-55, 55].map((z) => <mesh key={z} position={[79.6, 70, z]} material={doorMat}><boxGeometry args={[1, 139, 22]} /></mesh>)}
        <mesh position={[150, 12, -150]} material={buildingMat}><boxGeometry args={[60, 24, 115]} /></mesh>
      </group>
    </group>
  );
}

export function LaunchPad({ story }: { story: Signal }) {
  return (
    <group>
      <PadSurface />
      <MobileLauncher story={story} />
      <SiteStructures />
    </group>
  );
}
