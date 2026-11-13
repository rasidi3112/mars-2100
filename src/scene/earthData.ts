import { useEffect, useMemo, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { LAUNCH_LAT, LAUNCH_LON } from './approachLive';

// Real Earth imagery, built by scripts/build-earth-textures.py from NASA GIBS layers:
// Blue Marble (day), Black Marble 2016 (night lights), one day of VIIRS true colour reduced
// to a cloud map, and a Landsat 7 composite of the coast around Launch Complex 39B.
// The boxes below must match that script.

export const EARTH_BASE = `${import.meta.env?.BASE_URL ?? '/'}textures/earth/`;

// Mean Earth radius in metres. The launch scene is drawn at real scale: 1 unit = 1 m.
export const EARTH_METRES = 6371000;

const DEG = Math.PI / 180;
export const PAD = { lat: LAUNCH_LAT * DEG, lon: LAUNCH_LON * DEG };
// Half-spans (longitude, latitude) in radians of the two maps centred on the pad.
export const NEAR_SPAN = new THREE.Vector2(0.2278 * DEG, 0.2 * DEG);
export const MID_SPAN = new THREE.Vector2(3.4 * DEG, 3.0 * DEG);
// West, south, east, north in radians.
export const FAR_BOX = new THREE.Vector4(-100 * DEG, 8 * DEG, -52 * DEG, 48 * DEG);

export function useSmallScreen() {
  const gl = useThree((state) => state.gl);
  return useMemo(() => gl.capabilities.maxTextureSize < 4096 || window.matchMedia('(max-width: 800px), (max-height: 500px)').matches, [gl]);
}

function solidTexture(r: number, g: number, b: number) {
  const texture = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

type Loaded<K extends string> = Partial<Record<K, THREE.Texture>>;

// Loads a set of named textures. Each one replaces its flat stand-in as soon as it arrives;
// a failed download simply leaves the stand-in in place. `done` turns true when every file has
// either loaded or failed.
function useTextureSet<K extends string>(files: Record<K, string>, fallback: Record<K, [number, number, number]>, linear: NoInfer<K>[] = []) {
  const gl = useThree((state) => state.gl);
  const key = JSON.stringify(files);
  const placeholders = useMemo(() => {
    const out = {} as Record<K, THREE.Texture>;
    (Object.keys(fallback) as K[]).forEach((name) => { const [r, g, b] = fallback[name]; out[name] = solidTexture(r, g, b); });
    return out;
    // The stand-ins never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [loaded, setLoaded] = useState<Loaded<K>>({});
  const [done, setDone] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const mine: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    const names = Object.keys(files) as K[];
    let pending = names.length;
    const finish = () => { pending -= 1; if (pending === 0 && !cancelled) setDone(true); };
    names.forEach((name) => {
      loader.loadAsync(EARTH_BASE + files[name]).then((texture) => {
        if (cancelled) { texture.dispose(); return; }
        mine.push(texture);
        texture.colorSpace = linear.includes(name) ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
        texture.wrapS = THREE.RepeatWrapping;
        setLoaded((current) => ({ ...current, [name]: texture }));
        finish();
      }).catch(finish);
    });
    return () => { cancelled = true; mine.forEach((texture) => texture.dispose()); setLoaded({}); setDone(false); };
    // `key` stands for `files`, and `linear` is a constant list at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gl, key]);
  useEffect(() => () => { Object.values<THREE.Texture>(placeholders).forEach((texture) => texture.dispose()); }, [placeholders]);
  const maps = useMemo(() => {
    const out = {} as Record<K, THREE.Texture>;
    (Object.keys(placeholders) as K[]).forEach((name) => { out[name] = loaded[name] ?? placeholders[name]; });
    return out;
  }, [loaded, placeholders]);
  return { maps, done };
}

// Ground under the launch: three nested maps around the pad, then the whole globe.
export function useLaunchMaps() {
  const small = useSmallScreen();
  const size = small ? '1k' : '2k';
  return useTextureSet(
    { near: `launch-near-${size}.jpg`, mid: `launch-mid-${size}.jpg`, far: `launch-far-${size}.jpg`, globe: 'earth-color-2k.jpg' },
    { near: [44, 62, 40], mid: [30, 52, 62], far: [22, 44, 74], globe: [20, 40, 74] },
  );
}

// The globe seen during the cruise: day colour, night lights and cloud cover.
export function useGlobeMaps() {
  const small = useSmallScreen();
  return useTextureSet(
    { day: `earth-color-${small ? '2k' : '4k'}.jpg`, night: `earth-night-${small ? '1k' : '2k'}.jpg`, clouds: `earth-clouds-${small ? '2k' : '4k'}.jpg` },
    { day: [24, 46, 78], night: [0, 0, 0], clouds: [0, 0, 0] },
    ['clouds'],
  );
}
