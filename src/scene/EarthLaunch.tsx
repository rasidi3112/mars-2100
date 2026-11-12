import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Signal } from './Vehicles';
import { EARTH_RADIUS, LAUNCH_LAT, LAUNCH_LON } from './approachLive';

// Same mapping as SpaceScene.latLonToVector. Duplicated so this file does not
// import the scene that imports it.
function latLonToVector(lat: number, lon: number, radius: number) {
  const u = (lon + 180) / 360;
  const v = (90 - lat) / 180;
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  return new THREE.Vector3(-radius * Math.cos(phi) * Math.sin(theta), radius * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta));
}

// Earth colour is NASA's public-domain Blue Marble (land, ocean, ice), with the
// same equirectangular layout as the Mars globe: 180°W at the left edge.
// A painted stand-in shows until that image loads, or if it cannot.

const EARTH_BASE = `${import.meta.env?.BASE_URL ?? '/'}textures/earth/`;

const white = new THREE.MeshStandardMaterial({ color: '#f7f4ee', roughness: 0.38, metalness: 0.22, emissive: '#6a6258', emissiveIntensity: 0.35 });
const metal = new THREE.MeshStandardMaterial({ color: '#c5ccd4', roughness: 0.32, metalness: 0.58 });
const soot = new THREE.MeshStandardMaterial({ color: '#2a3038', roughness: 0.62, metalness: 0.35 });
const orange = new THREE.MeshStandardMaterial({ color: '#d4552a', roughness: 0.48, metalness: 0.18 });
const concrete = new THREE.MeshStandardMaterial({ color: '#8e8b86', roughness: 0.92, metalness: 0.02 });
const towerMat = new THREE.MeshStandardMaterial({ color: '#d9d3c8', roughness: 0.5, metalness: 0.38 });

const earthAtmosphereVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vView = normalize(cameraPosition - world.xyz);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;
const earthAtmosphereFragment = /* glsl */ `
  uniform vec3 uSun;
  uniform float uStrength;
  uniform float uMax;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float d = clamp(-dot(vNormal, vView) / uMax, 0.0, 1.0);
    float lit = smoothstep(-0.2, 0.55, dot(vNormal, uSun));
    float glow = pow(d, 1.7) * lit * uStrength;
    gl_FragColor = vec4(vec3(0.45, 0.68, 0.95) * glow, glow);
    #include <colorspace_fragment>
  }
`;

function createEarthPaint() {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const toX = (lon: number) => ((lon + 180) / 360) * width;
  const toY = (lat: number) => ((90 - lat) / 180) * height;
  ctx.fillStyle = '#1c4f86';
  ctx.fillRect(0, 0, width, height);
  const blob = (lon: number, lat: number, rx: number, ry: number, color: string) => {
    for (const offset of [-360, 0, 360]) {
      const x = toX(lon + offset);
      const y = toY(lat);
      const sx = (rx / 360) * width;
      const sy = (ry / 180) * height;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, sy / Math.max(0.001, sx));
      const fill = ctx.createRadialGradient(0, 0, 0, 0, 0, sx);
      fill.addColorStop(0, color);
      fill.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.arc(0, 0, sx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  };
  const land = 'rgba(96, 122, 62, 0.92)';
  const dry = 'rgba(176, 142, 86, 0.9)';
  [
    [-100, 45, 28, 18], [-90, 15, 16, 14], [-62, -10, 14, 22],
    [20, 8, 18, 22], [25, -22, 12, 14], [45, 25, 14, 10],
    [80, 45, 36, 18], [100, 35, 22, 14], [110, 60, 24, 12],
    [135, -25, 14, 10],
  ].forEach(([lon, lat, rx, ry]) => blob(lon, lat, rx, ry, land));
  [[20, 22, 16, 10], [45, 25, 12, 8], [70, 28, 14, 8]].forEach(([lon, lat, rx, ry]) => blob(lon, lat, rx, ry, dry));
  ctx.fillStyle = 'rgba(246, 248, 250, 0.95)';
  ctx.fillRect(0, 0, width, toY(78));
  ctx.fillRect(0, toY(-78), width, height - toY(-78));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function createCloudPaint() {
  const width = 1024;
  const height = 512;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  let seed = 4242;
  const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  for (let i = 0; i < 70; i += 1) {
    const x = rand() * width;
    const y = rand() * height;
    const radius = 18 + rand() * 50;
    const fill = ctx.createRadialGradient(x, y, 0, x, y, radius);
    fill.addColorStop(0, `rgba(255,255,255,${0.16 + rand() * 0.2})`);
    fill.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function useEarthMap() {
  const gl = useThree((state) => state.gl);
  const painted = useMemo(() => createEarthPaint(), []);
  const [map, setMap] = useState<THREE.Texture | null>(null);
  useEffect(() => () => { painted?.dispose(); }, [painted]);
  useEffect(() => {
    let cancelled = false;
    const small = gl.capabilities.maxTextureSize < 2048 || window.matchMedia('(max-width: 800px), (max-height: 500px)').matches;
    const loader = new THREE.TextureLoader();
    loader.loadAsync(`${EARTH_BASE}earth-color-${small ? '1k' : '2k'}.jpg`)
      .then((texture) => {
        if (cancelled) { texture.dispose(); return; }
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        setMap(texture);
      })
      .catch(() => { /* painted stand-in remains */ });
    return () => { cancelled = true; };
  }, [gl]);
  useEffect(() => () => { map?.dispose(); }, [map]);
  return map ?? painted;
}

const SITE = latLonToVector(LAUNCH_LAT, LAUNCH_LON, 1).normalize();
const EAST = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SITE).normalize();
const NORTH = new THREE.Vector3().crossVectors(SITE, EAST).normalize();
const UP = new THREE.Vector3(0, 1, 0);
const PAD_Q = new THREE.Quaternion().setFromUnitVectors(UP, SITE);
const TOWER = EAST.clone().applyQuaternion(PAD_Q.clone().invert());
TOWER.y = 0;
if (TOWER.lengthSq() > 0) TOWER.normalize().multiplyScalar(1.9);

export function alignEarth(group: THREE.Object3D) {
  // Stand the launch coast up in the frame so the rocket rises against the horizon.
  group.quaternion.setFromUnitVectors(SITE, new THREE.Vector3(0, 1, 0.08).normalize());
}

export function launchLocalPose(progress: number) {
  const hold = 0.1;
  const climb = smooth(progress, hold, 0.22);
  const alt = Math.pow(smooth(progress, hold, 1), 1.08) * 88;
  const pitch = smooth(progress, 0.4, 0.95) * 0.78;
  const downrange = Math.pow(smooth(progress, 0.4, 1), 1.25) * 48;
  const thrust = SITE.clone().multiplyScalar(Math.cos(pitch)).addScaledVector(EAST, Math.sin(pitch)).normalize();
  const position = SITE.clone().multiplyScalar(EARTH_RADIUS + 0.55 + alt).addScaledVector(EAST, downrange);
  const throttle = progress < hold ? 0.35 * (progress / hold) : 0.72 + 0.28 * climb;
  return { position, thrust, throttle, wide: 1 - smooth(progress, 0.02, 0.2), east: EAST, north: NORTH };
}

function smooth(value: number, edge0: number, edge1: number) {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function RocketBody() {
  return (
    <group>
      <mesh position={[0, 3.7, 0]} material={white} castShadow>
        <cylinderGeometry args={[0.78, 0.86, 6.6, 24]} />
      </mesh>
      <mesh position={[1.22, 2.9, 0]} material={white} castShadow>
        <cylinderGeometry args={[0.4, 0.46, 5.1, 16]} />
      </mesh>
      <mesh position={[-1.22, 2.9, 0]} material={white} castShadow>
        <cylinderGeometry args={[0.4, 0.46, 5.1, 16]} />
      </mesh>
      <mesh position={[1.22, 5.55, 0]} material={orange}>
        <coneGeometry args={[0.4, 0.7, 16]} />
      </mesh>
      <mesh position={[-1.22, 5.55, 0]} material={orange}>
        <coneGeometry args={[0.4, 0.7, 16]} />
      </mesh>
      <mesh position={[0, 7.15, 0]} material={soot}>
        <cylinderGeometry args={[0.78, 0.78, 0.28, 24]} />
      </mesh>
      <mesh position={[0, 8.35, 0]} material={white} castShadow>
        <cylinderGeometry args={[0.58, 0.76, 2.15, 24]} />
      </mesh>
      <mesh position={[0, 9.85, 0]} material={white} castShadow>
        <coneGeometry args={[0.58, 1.55, 24]} />
      </mesh>
      <mesh position={[0, 0.35, 0]} rotation={[Math.PI, 0, 0]} material={soot}>
        <coneGeometry args={[0.32, 0.55, 16]} />
      </mesh>
      <mesh position={[1.22, 0.28, 0]} rotation={[Math.PI, 0, 0]} material={metal}>
        <coneGeometry args={[0.2, 0.38, 12]} />
      </mesh>
      <mesh position={[-1.22, 0.28, 0]} rotation={[Math.PI, 0, 0]} material={metal}>
        <coneGeometry args={[0.2, 0.38, 12]} />
      </mesh>
    </group>
  );
}

function Pad() {
  const deck = SITE.clone().multiplyScalar(EARTH_RADIUS + 0.02);
  return (
    <group position={deck} quaternion={PAD_Q}>
      <mesh position={[0, 0.16, 0]} material={concrete} receiveShadow>
        <cylinderGeometry args={[2.15, 2.25, 0.18, 40]} />
      </mesh>
      <mesh position={[0, 0.3, 1.5]} material={soot}>
        <boxGeometry args={[1.5, 0.08, 3.4]} />
      </mesh>
      <group position={TOWER}>
        <mesh position={[0, 5.4, 0]} material={towerMat}>
          <boxGeometry args={[0.28, 10.6, 0.28]} />
        </mesh>
        <mesh position={[0, 7.6, 0]} material={towerMat}>
          <boxGeometry args={[1.6, 0.12, 0.16]} />
        </mesh>
      </group>
    </group>
  );
}

function Flames({ throttle, flame }: { throttle: Signal; flame: RefObject<THREE.Group | null> }) {
  const light = useRef<THREE.PointLight>(null);
  useFrame(({ clock }) => {
    const k = throttle.current;
    const flicker = 0.86 + Math.sin(clock.getElapsedTime() * 31) * 0.08 + Math.sin(clock.getElapsedTime() * 17) * 0.06;
    if (flame.current) {
      flame.current.visible = k > 0.04;
      const stretch = (1.1 + k * 3.6) * flicker;
      flame.current.scale.set(0.55 + k * 0.45, stretch, 0.55 + k * 0.45);
    }
    if (light.current) light.current.intensity = k * 7 * flicker;
  });
  return (
    <group ref={flame} position={[0, -0.15, 0]}>
      <mesh rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.55, 2.4, 16]} />
        <meshBasicMaterial color="#ffb15a" transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh position={[1.22, 0.1, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.28, 1.5, 12]} />
        <meshBasicMaterial color="#ffd2a0" transparent opacity={0.75} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh position={[-1.22, 0.1, 0]} rotation={[Math.PI, 0, 0]}>
        <coneGeometry args={[0.28, 1.5, 12]} />
        <meshBasicMaterial color="#ffd2a0" transparent opacity={0.75} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <pointLight ref={light} color="#ffb56a" intensity={0} distance={46} decay={2} />
    </group>
  );
}

export function EarthLaunch({ rocket, throttle, sun }: { rocket: RefObject<THREE.Group | null>; throttle: Signal; sun: Signal }) {
  const color = useEarthMap();
  const clouds = useMemo(() => createCloudPaint(), []);
  const cloudSpin = useRef<THREE.Mesh>(null);
  const sunLight = useRef<THREE.DirectionalLight>(null);
  const flame = useRef<THREE.Group>(null);
  const atmosphere = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: earthAtmosphereVertex,
    fragmentShader: earthAtmosphereFragment,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: {
      uSun: { value: new THREE.Vector3(0, 1, 0.08).normalize() },
      uStrength: { value: 1.15 },
      uMax: { value: Math.sqrt(1 - 1 / (1.028 * 1.028)) },
    },
  }), []);
  useEffect(() => () => { clouds?.dispose(); atmosphere.dispose(); }, [clouds, atmosphere]);
  useFrame((_, delta) => {
    if (cloudSpin.current) cloudSpin.current.rotation.y += delta * 0.012;
    if (sunLight.current) sunLight.current.intensity = sun.current;
  });
  const sunPos = SITE.clone().multiplyScalar(EARTH_RADIUS * 8);
  return (
    <group>
      <mesh>
        <sphereGeometry args={[EARTH_RADIUS, 192, 128]} />
        <meshStandardMaterial map={color ?? undefined} roughness={0.82} metalness={0.04} />
      </mesh>
      <mesh ref={cloudSpin} scale={1.012}>
        <sphereGeometry args={[EARTH_RADIUS, 96, 64]} />
        <meshStandardMaterial map={clouds ?? undefined} transparent opacity={0.42} depthWrite={false} roughness={1} metalness={0} />
      </mesh>
      <mesh scale={1.028} material={atmosphere}>
        <sphereGeometry args={[EARTH_RADIUS, 64, 48]} />
      </mesh>
      <directionalLight ref={sunLight} position={sunPos.toArray()} intensity={0} color="#fff6ea" />
      <Pad />
      <group ref={rocket}>
        <RocketBody />
        <Flames throttle={throttle} flame={flame} />
      </group>
    </group>
  );
}
