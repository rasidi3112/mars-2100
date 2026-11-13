import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Signal } from './Vehicles';
import { NOISE_GLSL } from './glsl';
import { SUN_DIRECTION, approachLive, launchHold } from './approachLive';
import { EARTH_METRES, FAR_BOX, MID_SPAN, NEAR_SPAN, PAD, useLaunchMaps, useSmallScreen } from './earthData';
import { LAUNCH_STORY, STORY_AT, launchLive, launchSample, storyFromProgress } from '../mission/launch';
import { LaunchVehicle, STACK, createFlightState, type FlightState } from './LaunchVehicle';
import { DECK_Y, LaunchPad } from './LaunchPad';

// The launch from Earth, at real scale: 1 unit is 1 metre, the planet has Earth's radius and the
// rocket climbs to its real altitude. The ground is NASA imagery (see earthData.ts): a Landsat
// composite around Launch Complex 39B, then Blue Marble out to the horizon. The sky, the cloud
// deck, the sea glint and the haze are drawn by one shader that traces each view ray against
// the curved ground. The rocket stays near the origin; the ground moves away beneath it.
// It is a visual model: the vehicle, the tower and the crew are a conceptual stand-in.

const CLOUD_BASE = 2300; // metres: scattered fair-weather cumulus

// ---------- sky, ground, sea and clouds ----------

const worldVertex = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    gl_Position.z = gl_Position.w * 0.99999; // always at the back
  }
`;

const worldFragment = /* glsl */ `
  uniform float uAlt;
  uniform vec2 uCam;
  uniform vec3 uSun;
  uniform float uTime;
  uniform float uR;
  uniform int uOct;
  uniform sampler2D uNear;
  uniform sampler2D uMid;
  uniform sampler2D uFar;
  uniform sampler2D uGlobe;
  uniform vec2 uPad;
  uniform vec2 uNearSpan;
  uniform vec2 uMidSpan;
  uniform vec4 uFarBox;
  varying vec3 vDir;
  ${NOISE_GLSL}

  const float SCALE_H = 8000.0;
  const float CLOUD_Y = ${CLOUD_BASE.toFixed(1)};
  const float PI = 3.14159265;

  vec3 skyColour(vec3 d, float h) {
    float rho = exp(-h / SCALE_H);
    float dip = acos(clamp(uR / (uR + h), -1.0, 1.0));
    float rel = asin(clamp(d.y, -1.0, 1.0)) + dip;
    vec3 L = normalize(uSun);
    float mu = dot(d, L);
    vec3 zenith = vec3(0.09, 0.24, 0.72);
    vec3 horizon = vec3(0.58, 0.70, 0.90);
    vec3 day = mix(horizon, zenith, pow(clamp(rel / 1.3, 0.0, 1.0), 0.5));
    day += vec3(1.0, 0.86, 0.66) * (pow(max(mu, 0.0), 6.0) * 0.32 + pow(max(mu, 0.0), 90.0) * 1.1);
    vec3 col = day * clamp(rho * 1.15, 0.0, 1.0);
    // High up: black sky with a thin blue band of air just above the horizon.
    vec2 flatD = normalize(d.xz + 1e-5);
    float sunSide = 0.55 + 0.45 * dot(flatD, normalize(L.xz));
    float band = exp(-max(rel, 0.0) * mix(5.0, 60.0, 1.0 - rho));
    col += (vec3(0.22, 0.48, 1.0) * band + vec3(0.7, 0.85, 1.0) * band * band * band * 0.6) * (1.0 - rho) * 0.95 * sunSide;
    return col * 1.45;
  }

  // Direction from the planet's centre to a point, in the pad's frame (east, north, up).
  // rel is the point relative to the camera; shell is that point's height above the ground.
  vec3 padFrame(vec3 rel, float shell) {
    float radius = uR + shell;
    vec3 n = vec3(rel.x, rel.y + uR + uAlt, rel.z + uCam.y) / radius;
    float alpha = uCam.x / uR;
    float ca = cos(alpha);
    float sa = sin(alpha);
    return vec3(n.x * ca + n.y * sa, -n.z, n.y * ca - n.x * sa);
  }

  float edgeFade(vec2 uv, float margin) {
    vec2 e = min(uv, 1.0 - uv);
    return smoothstep(0.0, margin, min(e.x, e.y));
  }

  // Ground colour from the nested NASA maps, and a water mask in alpha.
  vec4 groundAt(vec3 n) {
    float s0 = sin(uPad.x);
    float c0 = cos(uPad.x);
    float lat = asin(clamp(n.z * s0 + n.y * c0, -1.0, 1.0));
    float dLon = atan(n.x, n.z * c0 - n.y * s0);
    float dLat = lat - uPad.x;
    float lon = uPad.y + dLon;
    vec2 uvN = 0.5 + 0.5 * vec2(dLon / uNearSpan.x, dLat / uNearSpan.y);
    vec2 uvM = 0.5 + 0.5 * vec2(dLon / uMidSpan.x, dLat / uMidSpan.y);
    vec2 uvF = vec2((lon - uFarBox.x) / (uFarBox.z - uFarBox.x), (lat - uFarBox.y) / (uFarBox.w - uFarBox.y));
    vec2 uvG = vec2(lon / (2.0 * PI) + 0.5, lat / PI + 0.5);
    vec3 col = texture2D(uGlobe, uvG).rgb;
    col = mix(col, texture2D(uFar, clamp(uvF, 0.0, 1.0)).rgb, edgeFade(uvF, 0.06));
    col = mix(col, texture2D(uMid, clamp(uvM, 0.0, 1.0)).rgb, edgeFade(uvM, 0.1));
    float wNear = edgeFade(uvN, 0.12);
    vec3 near = texture2D(uNear, clamp(uvN, 0.0, 1.0)).rgb;
    // The Landsat composite is a little darker and greener than Blue Marble; meet it halfway.
    col = mix(col, near * vec3(0.6, 0.56, 0.64), wNear);
    float water = smoothstep(0.012, 0.05, col.b - col.r) * (1.0 - smoothstep(0.22, 0.45, col.r));
    return vec4(col, water);
  }

  vec3 hazeColour(float h) {
    float rho = exp(-h / SCALE_H);
    vec3 low = skyColour(normalize(vec3(0.7, 0.03, 0.7)), 0.0) * 0.62;
    return mix(vec3(0.3, 0.5, 0.98) * 1.05, low, clamp(rho * 1.4, 0.0, 1.0));
  }

  vec3 shadeGround(vec3 d, float t, float h) {
    vec3 L = normalize(uSun);
    vec3 n = padFrame(d * t, 0.0);
    vec2 p = vec2(n.x, -n.y) * uR; // metres east and south of the pad
    vec4 g = groundAt(n);
    vec3 sun = vec3(1.0, 0.95, 0.86) * 2.5;
    vec3 ambient = vec3(0.32, 0.42, 0.6) * 0.6;
    // Local "up" at the hit point, in the camera's frame.
    vec3 up = normalize(vec3(d.x * t, d.y * t + uR + h, d.z * t));
    float ndl = max(dot(up, L), 0.0);
    vec3 albedo = g.rgb * 1.9;
    // Fine detail the 21 m imagery cannot hold, so the ground does not look soft near the pad.
    float fine = 1.0 - smoothstep(400.0, 7000.0, t);
    if (fine > 0.0) {
      float patches = fbm(vec3(p * 0.021, 5.0), 4);
      float scrub = vnoise(vec3(p * 0.16, 0.0)) * 0.6 + vnoise(vec3(p * 0.7, 2.0)) * 0.4;
      float close = 1.0 - smoothstep(200.0, 2400.0, t);
      float detail = mix(1.0, 0.7 + 0.5 * patches, 0.4 + 0.6 * close) * mix(1.0, 0.78 + 0.44 * scrub, close);
      albedo *= mix(1.0, detail, fine * (1.0 - g.a));
    }
    vec3 col = albedo * (sun * ndl + ambient);
    if (g.a > 0.01) {
      // Water: wave normal, sky reflection, sun glint (sharper close up, broader far away).
      float k = 0.22 * (1.0 - smoothstep(400.0, 14000.0, t));
      vec3 q = vec3(p * 0.008 + vec2(uTime * 0.18, uTime * 0.07), uTime * 0.15);
      vec3 q2 = vec3(p * 0.038 + vec2(-uTime * 0.3, uTime * 0.22), uTime * 0.4);
      float n0 = vnoise(q) + 0.45 * vnoise(q2);
      float gx = vnoise(q + vec3(0.3, 0.0, 0.0)) + 0.45 * vnoise(q2 + vec3(0.3, 0.0, 0.0)) - n0;
      float gz = vnoise(q + vec3(0.0, 0.3, 0.0)) + 0.45 * vnoise(q2 + vec3(0.0, 0.3, 0.0)) - n0;
      vec3 wn = normalize(up + vec3(gx, 0.0, gz) * k * 5.0);
      vec3 R = reflect(d, wn);
      float fres = 0.02 + 0.98 * pow(1.0 - max(dot(wn, -d), 0.0), 5.0);
      vec3 refl = skyColour(normalize(vec3(R.x, abs(R.y) + 0.02, R.z)), 0.0);
      vec3 sea = mix(col, refl, fres * 0.85);
      float power = mix(900.0, 26.0, smoothstep(600.0, 400000.0, t));
      sea += sun * pow(max(dot(R, L), 0.0), power) * (power + 8.0) * 0.012 * mix(1.0, 0.25, smoothstep(20000.0, 600000.0, t));
      col = mix(col, sea, g.a);
    }
    float dens = h < 1.0 ? 1.0 : (SCALE_H / h) * (1.0 - exp(-h / SCALE_H));
    float haze = 1.0 - exp(-t * dens / 52000.0);
    return mix(col, hazeColour(h), haze);
  }

  // Cloud cover at a point of the deck (metres east/south of the pad). x = cover, y = the
  // noise value, for shading.
  vec2 cloudAt(vec2 cp, float blur) {
    float fields = fbm(vec3(cp * 0.000022, 9.0), 5);
    float systems = fbm(vec3(cp * 0.0000034, 3.0), 4);
    float threshold = 0.69 - (fields - 0.5) * 0.42 - (systems - 0.5) * 0.5;
    vec3 q = vec3(cp * 0.00038, uTime * 0.008);
    float n = fbm(q + fbm(q * 2.0, 3) * 0.6, uOct) + (vnoise(vec3(cp * 0.0036, 4.0)) - 0.5) * 0.12;
    float soft = mix(0.07, 0.3, blur);
    float cover = smoothstep(threshold - soft, threshold + soft, n);
    // Far away the cells are smaller than a pixel: show the cloud fields and weather systems.
    float wide = smoothstep(0.58, 0.8, fields * 0.55 + systems * 0.6) * 0.8;
    cover = mix(cover, wide, blur * blur);
    // The sky over the pad is clear: launch weather rules.
    cover *= smoothstep(2200.0, 6000.0, length(cp));
    return vec2(cover, n);
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = max(uAlt, 1.5);
    vec3 L = normalize(uSun);
    // Curved ground: a sphere of radius uR under the camera. Written so it stays precise.
    float b = (h + uR) * d.y;
    float c = h * (2.0 * uR + h);
    float disc = b * b - c;
    float tg = -1.0;
    if (disc > 0.0 && b < 0.0) tg = c / (-b + sqrt(disc));
    vec3 col;
    if (tg > 0.0) {
      col = shadeGround(d, tg, h);
    } else {
      col = skyColour(d, h);
      float mu = dot(d, L);
      col += vec3(1.0, 0.96, 0.9) * smoothstep(0.99985, 0.99994, mu) * 28.0;
      float rho = exp(-h / SCALE_H);
      if (rho < 0.35) {
        vec3 cell = d * 1100.0;
        float s = hash3(floor(cell));
        float bright = hash3(floor(cell) + 7.1);
        float dotShape = 1.0 - smoothstep(0.15, 0.5, length(fract(cell) - 0.5));
        col += vec3(0.9, 0.93, 1.0) * step(0.9986, s) * dotShape * (0.5 + 1.6 * bright) * (1.0 - rho / 0.35);
      }
    }
    // The cloud deck is a shell that curves with the ground, so it ends at the horizon.
    float hc = h - CLOUD_Y;
    float rc = uR + CLOUD_Y;
    float bc = (hc + rc) * d.y;
    float cc = hc * (2.0 * rc + hc);
    float dc = bc * bc - cc;
    float tc = -1.0;
    if (hc > 0.0) { if (dc > 0.0 && bc < 0.0) tc = cc / (-bc + sqrt(dc)); }
    else tc = -bc + sqrt(max(dc, 0.0));
    if (tc > 0.0 && (tg < 0.0 || tc < tg)) {
      vec3 n = padFrame(d * tc, CLOUD_Y);
      vec2 cp = vec2(n.x, -n.y) * uR;
      // Soften only where cloud cells shrink below a few pixels: far away and at grazing angles.
      vec3 upc = normalize(vec3(d.x * tc, d.y * tc + rc + hc, d.z * tc));
      float grazing = max(abs(dot(d, upc)), 0.04);
      float blur = smoothstep(30000.0, 240000.0, tc / (grazing * 2.0 + 0.2));
      vec2 cl = cloudAt(cp, blur);
      if (cl.x > 0.0) {
        float below = step(h, CLOUD_Y);
        float lit = 0.7 + 0.9 * max(dot(upc, L), 0.0);
        // Thicker cloud is darker underneath and brighter on top.
        vec3 cloud = vec3(1.0) * lit * mix(mix(1.02, 1.3, smoothstep(0.55, 0.9, cl.y)), 0.8, below * smoothstep(0.6, 0.85, cl.y)) * 1.3;
        float dens = (SCALE_H / max(abs(hc), 1.0)) * abs(exp(-min(h, CLOUD_Y) / SCALE_H) - exp(-max(h, CLOUD_Y) / SCALE_H));
        float haze = 1.0 - exp(-tc * clamp(dens, 0.0, 1.0) / 52000.0);
        cloud = mix(cloud, hazeColour(h), haze);
        col = mix(col, cloud, cl.x * 0.93);
      }
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------- sky light for the hull ----------

// A small picture of the morning sky, blurred into an environment map, so painted metal
// picks up blue from above, warm light from the sun side and green-grey from the ground.
function createSkyEnvironment(gl: THREE.WebGLRenderer) {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uSun: { value: SUN_DIRECTION.clone() } },
    vertexShader: /* glsl */ `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uSun;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        vec3 sky = mix(vec3(0.62, 0.74, 0.92), vec3(0.14, 0.3, 0.74), pow(clamp(d.y, 0.0, 1.0), 0.55));
        vec3 ground = mix(vec3(0.2, 0.22, 0.16), vec3(0.34, 0.33, 0.3), clamp(-d.y * 3.0, 0.0, 1.0));
        vec3 col = mix(ground, sky, smoothstep(-0.04, 0.04, d.y));
        float mu = max(dot(d, normalize(uSun)), 0.0);
        col += vec3(1.0, 0.9, 0.74) * (pow(mu, 8.0) * 0.6 + pow(mu, 200.0) * 14.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const geometry = new THREE.SphereGeometry(10, 32, 16);
  scene.add(new THREE.Mesh(geometry, material));
  const pmrem = new THREE.PMREMGenerator(gl);
  const target = pmrem.fromScene(scene, 0.03);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return target;
}

// ---------- smoke ----------

// Camera-facing quads rather than GL points, so puff size is not capped by the GPU's point size limit.
const smokeVertex = /* glsl */ `
  attribute vec3 aOffset;
  attribute float aSize;
  attribute float aAlpha;
  attribute float aHeat;
  varying float vAlpha;
  varying float vHeat;
  varying vec2 vUv;
  varying float vSeed;
  void main() {
    vSeed = float(gl_InstanceID) * 0.618;
    vec4 mv = modelViewMatrix * vec4(aOffset, 1.0);
    mv.xy += position.xy * aSize;
    gl_Position = projectionMatrix * mv;
    vAlpha = aAlpha;
    vHeat = aHeat;
    vUv = uv;
  }
`;
const smokeFragment = /* glsl */ `
  uniform float uLight;
  varying float vAlpha;
  varying float vHeat;
  varying vec2 vUv;
  varying float vSeed;
  ${NOISE_GLSL}
  void main() {
    vec2 c = vUv - 0.5;
    c.y = -c.y;
    float r = length(c);
    if (r > 0.5) discard;
    float lump = fbm(vec3(c * 5.0, vSeed), 3);
    float soft = smoothstep(0.5, 0.08, r + (lump - 0.5) * 0.35) * (0.55 + 0.7 * lump);
    // Lit from above-right, a little darker underneath.
    float shade = (0.62 + 0.38 * clamp(0.5 - c.y + c.x * 0.4, 0.0, 1.0)) * (0.8 + 0.35 * lump);
    vec3 colour = vec3(0.88, 0.87, 0.85) * shade * uLight;
    colour = mix(colour, vec3(1.0, 0.62, 0.28) * 1.8, vHeat);
    gl_FragColor = vec4(colour, soft * vAlpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const GROUND = 0; // steam and exhaust rolling out of the flame trench
const TRAIL = 1; // the column left behind the boosters
const VENT = 2; // cold oxygen vapour drifting off the tanks before launch

// Smoke lives in the site's frame, so the trail stays where it was laid while the rocket climbs.
function LaunchSmoke({ nozzle, down, flight, altitude, story, small }: {
  nozzle: THREE.Vector3; down: THREE.Vector3; flight: FlightState; altitude: Signal; story: Signal; small: boolean;
}) {
  const max = small ? 700 : 1500;
  const state = useMemo(() => ({
    pos: new Float32Array(max * 3),
    vel: new Float32Array(max * 3),
    age: new Float32Array(max).fill(1),
    life: new Float32Array(max).fill(1),
    grow: new Float32Array(max),
    scale: new Float32Array(max),
    kind: new Uint8Array(max),
    next: 0,
    carry: 0,
    groundCarry: 0,
    ventCarry: 0,
    last: new THREE.Vector3(),
    hasLast: false,
    lastStory: 0,
  }), [max]);
  const geometry = useMemo(() => {
    const quad = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = quad.index;
    g.setAttribute('position', quad.getAttribute('position'));
    g.setAttribute('uv', quad.getAttribute('uv'));
    g.setAttribute('aOffset', new THREE.InstancedBufferAttribute(state.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aHeat', new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage));
    g.instanceCount = max;
    return g;
  }, [state, max]);
  const material = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: smokeVertex,
    fragmentShader: smokeFragment,
    transparent: true,
    depthWrite: false,
    uniforms: { uLight: { value: 1.7 } },
  }), []);
  useEffect(() => () => { geometry.dispose(); material.dispose(); }, [geometry, material]);

  useFrame((_, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const s = state;
    const alt = altitude.current;
    const thrust = Math.max(flight.boosters, flight.core * 0.22);
    const lifted = flight.boosters > 0.05;
    const spawn = (kind: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, life: number, grow: number, scale: number) => {
      const i = s.next;
      s.next = (s.next + 1) % max;
      s.pos[i * 3] = px; s.pos[i * 3 + 1] = py; s.pos[i * 3 + 2] = pz;
      s.vel[i * 3] = vx; s.vel[i * 3 + 1] = vy; s.vel[i * 3 + 2] = vz;
      s.age[i] = 0; s.life[i] = life; s.grow[i] = grow; s.scale[i] = scale; s.kind[i] = kind;
    };
    // A jump in story time (a restart, or the reduced-motion stills) clears what was there.
    if (Math.abs(story.current - s.lastStory) > 1.5) { s.age.fill(1); s.hasLast = false; s.carry = 0; }
    s.lastStory = story.current;

    if (story.current < LAUNCH_STORY.liftoff && story.current > 0.01) {
      // Boil-off drifting from the tank vents while the rocket waits.
      s.ventCarry += (small ? 5 : 9) * delta;
      while (s.ventCarry >= 1) {
        s.ventCarry -= 1;
        const high = Math.random() < 0.5;
        spawn(VENT, 4.4, DECK_Y + (high ? 63 : 21) + Math.random() * 2, (Math.random() - 0.5) * 2,
          2.5 + Math.random() * 2.5, -0.6 + Math.random() * 0.8, 1.2 + Math.random(), 3.2 + Math.random() * 2.2, 1.6, 1);
      }
    }
    if (thrust < 0.02) {
      s.hasLast = false; s.carry = 0;
    } else {
      // Exhaust and deluge steam pour out of both ends of the flame trench, then billow up.
      if (alt < 220) {
        s.groundCarry += (small ? 150 : 300) * thrust * delta * (1 - alt / 220);
        const count = Math.min(60, Math.floor(s.groundCarry));
        s.groundCarry -= count;
        for (let n = 0; n < count; n += 1) {
          const trench = !lifted || Math.random() < 0.76;
          const end = Math.random() < 0.5 ? 1 : -1;
          if (trench) {
            const speed = (46 + Math.random() * 60) * (lifted ? 1 : 0.45);
            spawn(GROUND, (Math.random() - 0.5) * 14, 15 + Math.random() * 5, end * (20 + Math.random() * 30),
              (Math.random() - 0.5) * 20 + 3, 5 + Math.random() * 16, end * speed, 4.5 + Math.random() * 3.5, 2.4 + Math.random() * 1.8, 1);
          } else {
            const a = Math.random() * Math.PI * 2;
            const speed = 14 + Math.random() * 34;
            spawn(GROUND, Math.cos(a) * 16, DECK_Y - 4 + Math.random() * 6, Math.sin(a) * 16,
              Math.cos(a) * speed + 3, 2 + Math.random() * 7, Math.sin(a) * speed, 4 + Math.random() * 3, 2.2 + Math.random() * 1.6, 0.8);
          }
        }
      }
      // Trail: spaced along the path; puffs get wider and fade higher up. Only the solid
      // boosters leave one — hydrogen engines burn almost clear.
      if (s.hasLast && flight.boosters > 0.05 && alt > 2) {
        const step = 3.4 + alt * 0.012;
        const gap = s.last.distanceTo(nozzle) + s.carry;
        let n = Math.floor(gap / step);
        s.carry = gap - n * step;
        n = Math.min(n, 30);
        const spread = 1.6 + alt * 0.004;
        const scale = (1 + alt * 0.002) * Math.exp(-alt / 25000);
        for (let j = 0; j < n; j += 1) {
          const t = (j + 1) / (n + 1);
          spawn(TRAIL,
            THREE.MathUtils.lerp(s.last.x, nozzle.x, t) + (Math.random() - 0.5) * spread,
            THREE.MathUtils.lerp(s.last.y, nozzle.y, t) + (Math.random() - 0.5) * spread,
            THREE.MathUtils.lerp(s.last.z, nozzle.z, t) + (Math.random() - 0.5) * spread,
            down.x * 8 + (Math.random() - 0.5) * 4.4, down.y * 8 + (Math.random() - 0.5) * 4.4, down.z * 8 + (Math.random() - 0.5) * 4.4,
            5 + Math.random() * 2.5, 1.2 + Math.random() * 0.6, scale);
        }
      }
      s.last.copy(nozzle);
      s.hasLast = true;
    }
    const sizeArr = (geometry.getAttribute('aSize') as THREE.BufferAttribute).array as Float32Array;
    const alphaArr = (geometry.getAttribute('aAlpha') as THREE.BufferAttribute).array as Float32Array;
    const heatArr = (geometry.getAttribute('aHeat') as THREE.BufferAttribute).array as Float32Array;
    const hot = flight.boosters > 0.3 ? 1 : 0.12;
    for (let i = 0; i < max; i += 1) {
      if (s.age[i] >= 1) { alphaArr[i] = 0; continue; }
      const kind = s.kind[i];
      s.age[i] = Math.min(1, s.age[i] + delta / s.life[i]);
      const drag = Math.exp(-delta * (kind === GROUND ? 0.9 : 0.5));
      s.vel[i * 3] *= drag; s.vel[i * 3 + 1] *= drag; s.vel[i * 3 + 2] *= drag;
      if (kind === GROUND) s.vel[i * 3 + 1] += delta * 3.4; // warm cloud rises slowly
      s.pos[i * 3] += s.vel[i * 3] * delta;
      s.pos[i * 3 + 1] = Math.max(kind === GROUND ? 5 : 0, s.pos[i * 3 + 1] + s.vel[i * 3 + 1] * delta);
      s.pos[i * 3 + 2] += s.vel[i * 3 + 2] * delta;
      const a = s.age[i];
      const base = kind === GROUND ? 19 * s.scale[i] : kind === TRAIL ? 7.8 * s.scale[i] : 2.6;
      sizeArr[i] = base * (0.8 + a * s.grow[i] * 2.4);
      const fade = kind === GROUND ? 0.44 : kind === TRAIL ? 0.42 * Math.min(1, s.scale[i] * 3) : 0.2;
      alphaArr[i] = fade * Math.min(1, a * 7) * (1 - a) * (1 - a * 0.3);
      heatArr[i] = kind === VENT ? 0 : Math.max(0, 1 - a * 10) * (kind === GROUND ? 0.9 * hot : 0.6);
    }
    (geometry.getAttribute('aOffset') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
    (geometry.getAttribute('aHeat') as THREE.BufferAttribute).needsUpdate = true;
  });
  return <mesh geometry={geometry} material={material} frustumCulled={false} renderOrder={2} />;
}

// ---------- cameras ----------

type ShotId = 'boardWide' | 'boardClose' | 'retract' | 'engines' | 'padWide' | 'chase' | 'side' | 'lookBack' | 'nose' | 'limb' | 'staging';

function shotAt(story: number): ShotId {
  if (story < 3.3) return 'boardWide';
  if (story < LAUNCH_STORY.armRetract) return 'boardClose';
  if (story < LAUNCH_STORY.countdown) return 'retract';
  if (story < 12.3) return 'engines';
  if (story < 19.5) return 'padWide';
  if (story < 25.2) return 'chase';
  if (story < 30.2) return 'side';
  if (story < 36) return 'lookBack';
  if (story < 40.4) return 'nose';
  if (story < 42) return 'limb';
  return 'staging';
}

const SHOT_FOV: Record<ShotId, number> = {
  boardWide: 30, boardClose: 27, retract: 30, engines: 30, padWide: 26, chase: 42, side: 40, lookBack: 46, nose: 46, limb: 50, staging: 44,
};

const HATCH_Y = DECK_Y + STACK.hatchY;
const GROUND_CAMERA = new THREE.Vector3(-205, 21, 290);
const BASE_FOV = 42;

// ---------- the launch ----------

export function LaunchSite({ active, reducedMotion }: { active: boolean; reducedMotion: boolean }) {
  const root = useRef<THREE.Group>(null);
  const site = useRef<THREE.Group>(null);
  const pad = useRef<THREE.Group>(null);
  const rocket = useRef<THREE.Group>(null);
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const dome = useRef<THREE.Mesh>(null);
  const gl = useThree((state) => state.gl);
  const small = useSmallScreen();
  const { maps, done } = useLaunchMaps();
  const environment = useMemo(() => createSkyEnvironment(gl), [gl]);
  const flight = useMemo(() => createFlightState(), []);
  const story = useMemo<Signal>(() => ({ current: 0 }), []);
  const altitude = useMemo<Signal>(() => ({ current: 0 }), []);
  const nozzle = useMemo(() => new THREE.Vector3(), []);
  const down = useMemo(() => new THREE.Vector3(), []);
  const goal = useMemo(() => new THREE.Vector3(), []);
  const look = useMemo(() => new THREE.Vector3(), []);
  const centre = useMemo(() => new THREE.Vector3(), []);
  const tip = useMemo(() => new THREE.Vector3(), []);
  const axisZ = useMemo(() => new THREE.Vector3(0, 0, 1), []);
  const axisY = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const roll = useMemo(() => new THREE.Quaternion(), []);
  const skyTop = useMemo(() => new THREE.Color('#a9c6ff'), []);
  const groundLow = useMemo(() => new THREE.Color('#6f705f'), []);
  const groundHigh = useMemo(() => new THREE.Color('#8fb4ff'), []);
  const shot = useRef<ShotId | ''>('');
  const held = useRef(-1);
  const fovSet = useRef(false);
  const worldMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: worldVertex,
    fragmentShader: worldFragment,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      uAlt: { value: 3 },
      uCam: { value: new THREE.Vector2() },
      uSun: { value: SUN_DIRECTION.clone() },
      uTime: { value: 0 },
      uR: { value: EARTH_METRES },
      uOct: { value: small ? 4 : 5 },
      uNear: { value: null as THREE.Texture | null },
      uMid: { value: null as THREE.Texture | null },
      uFar: { value: null as THREE.Texture | null },
      uGlobe: { value: null as THREE.Texture | null },
      uPad: { value: new THREE.Vector2(PAD.lat, PAD.lon) },
      uNearSpan: { value: NEAR_SPAN.clone() },
      uMidSpan: { value: MID_SPAN.clone() },
      uFarBox: { value: FAR_BOX.clone() },
    },
  }), [small]);
  useEffect(() => {
    worldMaterial.uniforms.uNear.value = maps.near;
    worldMaterial.uniforms.uMid.value = maps.mid;
    worldMaterial.uniforms.uFar.value = maps.far;
    worldMaterial.uniforms.uGlobe.value = maps.globe;
  }, [worldMaterial, maps]);
  useEffect(() => { approachLive.mapsReady = done; }, [done]);
  useEffect(() => () => { worldMaterial.dispose(); }, [worldMaterial]);
  useEffect(() => () => { environment.dispose(); }, [environment]);
  useEffect(() => {
    const light = sun.current;
    if (!light) return;
    light.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    const cam = light.shadow.camera;
    cam.left = -150; cam.right = 150; cam.top = 170; cam.bottom = -130; cam.near = 20; cam.far = 760;
    cam.updateProjectionMatrix();
    light.shadow.bias = -0.0006;
    light.shadow.normalBias = 0.5;
  }, [small]);

  useFrame(({ camera, clock, size }, rawDelta) => {
    const delta = Math.min(rawDelta, 0.05);
    const cam = camera as THREE.PerspectiveCamera;
    const on = active && approachLive.segment === 'earth';
    if (root.current) root.current.visible = on;
    if (!on) {
      flight.core = 0; flight.boosters = 0; flight.upper = 0;
      if (fovSet.current) { cam.fov = BASE_FOV; cam.updateProjectionMatrix(); fovSet.current = false; }
      shot.current = '';
      return;
    }
    // A held moment (development) is reached by running the last seconds before it, so smoke,
    // trail and staging look as they would in play.
    if (launchHold !== null) held.current = Math.min(launchHold, held.current < 0 ? Math.max(0, launchHold - 3.5) : held.current + 0.05);
    const s = launchHold !== null ? held.current : storyFromProgress(approachLive.launchProgress, reducedMotion);
    if (launchHold !== null && s >= launchHold) (window as unknown as { launchHeld?: boolean }).launchHeld = true;
    const sample = launchSample(s);
    Object.assign(launchLive, sample);
    story.current = s;
    const alt = sample.altitudeKm * 1000;
    const range = sample.downrangeKm * 1000;
    altitude.current = alt;

    // Engines. The core starts first and runs to cutoff; the boosters light at T−0.
    const ramp = (from: number, seconds: number) => THREE.MathUtils.clamp((s - from) / seconds, 0, 1);
    flight.core = s < STORY_AT.meco ? ramp(STORY_AT.engineStart, 1.3) : 1 - ramp(STORY_AT.meco, 0.35);
    flight.boosters = s < LAUNCH_STORY.liftoff ? 0 : s < STORY_AT.boosterSep ? 1 - 0.55 * ramp(STORY_AT.boosterSep - 1.2, 1.2) : 0.45 * (1 - ramp(STORY_AT.boosterSep, 0.9));
    flight.upper = ramp(STORY_AT.stageSep + 0.9, 0.5);
    if (reducedMotion) { flight.core = Math.min(flight.core, 0.6); flight.boosters = Math.min(flight.boosters, 0.6); }
    flight.sinceBoosterSep = s - STORY_AT.boosterSep;
    flight.sinceAbortJettison = s - STORY_AT.abortJettison;
    flight.sinceStageSep = s - STORY_AT.stageSep;
    flight.spread = 1 + Math.min(3.6, alt / 14000);
    flight.clipY = -alt + 0.05;

    // The rocket stays near the origin; the ground moves away under it.
    site.current?.position.set(-range, -DECK_Y - alt, 0);
    site.current?.updateMatrixWorld();
    if (site.current) site.current.visible = alt < 60000;
    if (pad.current) pad.current.visible = alt < 16000;
    if (rocket.current) {
      // Pitch over toward the east, with a slow roll after the tower is cleared.
      rocket.current.quaternion.setFromAxisAngle(axisZ, -sample.pitch);
      roll.setFromAxisAngle(axisY, -1.2 * THREE.MathUtils.smoothstep(sample.met, 9, 34));
      rocket.current.quaternion.multiply(roll);
      rocket.current.updateMatrixWorld();
    }
    const sin = Math.sin(sample.pitch);
    const cos = Math.cos(sample.pitch);
    centre.set(sin * 49, cos * 49, 0);
    tip.set(sin * 90, cos * 90, 0);

    // Smoke works in the site's frame: where the nozzles are relative to the ground.
    if (site.current) {
      nozzle.set(-sin * 4, -cos * 4, 0).sub(site.current.position);
      down.set(-sin, -cos, 0);
    }

    // Cameras. Shots before liftoff are fixed to the pad; later ones travel with the rocket.
    const id = shotAt(s);
    const cut = shot.current !== id;
    shot.current = id;
    const aspect = size.width / size.height;
    const narrow = Math.max(1, 0.82 / aspect); // step back on tall screens so the subject still fits
    const fov = SHOT_FOV[id];
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); }
    fovSet.current = true;
    const siteY = -DECK_Y - alt;
    let smooth = 0;
    if (id === 'boardWide') {
      const k = s / 3.3;
      goal.set((37 - k * 5) * narrow, HATCH_Y + 5.5 + siteY, -18 + k * 2);
      look.set(0, HATCH_Y + 0.4 + siteY, -12.5);
    } else if (id === 'boardClose') {
      const k = (s - 3.3) / (LAUNCH_STORY.armRetract - 3.3);
      goal.set((13.5 - k * 1.5) * narrow, HATCH_Y + 1.5 + siteY, -21.5 + k * 1.5);
      look.set(-0.4, HATCH_Y + 0.5 + siteY, -9.5);
    } else if (id === 'retract') {
      const k = (s - LAUNCH_STORY.armRetract) / (LAUNCH_STORY.countdown - LAUNCH_STORY.armRetract);
      goal.set((104 - k * 6) * narrow, HATCH_Y - 8 + siteY, 82 * narrow);
      look.set(5, HATCH_Y - 15 + siteY, -12);
    } else if (id === 'engines') {
      const k = (s - LAUNCH_STORY.countdown) / (12.3 - LAUNCH_STORY.countdown);
      goal.set((78 - k * 5) * narrow, 34 + siteY, 112 * narrow);
      look.set(0, DECK_Y + 9 + siteY, 0);
    } else if (id === 'padWide') {
      goal.set(GROUND_CAMERA.x * narrow - range, GROUND_CAMERA.y + siteY, GROUND_CAMERA.z * narrow);
      if (!reducedMotion && flight.boosters > 0.5 && alt < 400) {
        const shake = 0.45 * (1 - alt / 400);
        goal.x += Math.sin(s * 47) * shake;
        goal.y += Math.sin(s * 31) * shake;
      }
      // Hold the whole stack in frame, then follow it up off the pad.
      look.set(0, 46 - Math.min(alt, 30) * 0.5, 0);
    } else if (id === 'chase') {
      const k = 1 + alt / 14000;
      goal.set(centre.x - 150 * k, centre.y + 26 * k, 82 * k * narrow);
      look.set(centre.x + 12 * k, centre.y - 8 * k, 0);
      smooth = 3;
    } else if (id === 'side') {
      const k = 1 + alt / 22000;
      goal.set(centre.x + 36 * k, centre.y + 16 * k, 215 * k * narrow);
      look.set(centre.x - 4 * k, centre.y - 4 * k, 0);
      smooth = 3;
    } else if (id === 'lookBack') {
      // Ahead of the rocket and above it, looking back at the coast it left.
      const k = 1 + alt / 70000;
      goal.set(centre.x + 118 * k, centre.y + 78 * k, 92 * k * narrow);
      look.set(centre.x - 30, centre.y - 26, -6);
      smooth = 2.5;
    } else if (id === 'nose') {
      goal.set(tip.x + 34, tip.y + 34, 58 * narrow);
      look.set(tip.x - 14, tip.y - 6, 0);
      smooth = 4;
    } else if (id === 'limb') {
      goal.set(centre.x - 210, centre.y + 74, 270 * narrow);
      look.set(centre.x + 80, centre.y - 26, 0);
      smooth = 3;
    } else {
      goal.set(sin * 70 - 30, cos * 70 + 46, 150 * narrow);
      look.set(sin * 62, cos * 62 - 4, 0);
      smooth = 3;
    }
    if (cut || smooth === 0 || reducedMotion) cam.position.copy(goal);
    else cam.position.lerp(goal, 1 - Math.exp(-delta * smooth));
    cam.lookAt(look);

    // The sky dome follows the camera; the shader knows the camera's height and map position.
    if (dome.current) dome.current.position.copy(cam.position);
    const camAlt = Math.max(1.5, cam.position.y + DECK_Y + alt);
    worldMaterial.uniforms.uAlt.value = camAlt;
    (worldMaterial.uniforms.uCam.value as THREE.Vector2).set(cam.position.x + range, cam.position.z);
    worldMaterial.uniforms.uTime.value = clock.getElapsedTime();
    // Sky light fades as the air thins; light bounced off the Earth below takes over.
    const sky = Math.exp(-camAlt / 9000);
    flight.sky = sky;
    if (hemi.current) {
      hemi.current.intensity = 0.55 + 1.15 * sky;
      hemi.current.color.copy(skyTop).multiplyScalar(0.12 + 0.88 * sky);
      hemi.current.groundColor.copy(groundLow).lerp(groundHigh, 1 - sky);
    }
  });

  return (
    <group ref={root} visible={false}>
      <mesh ref={dome} material={worldMaterial} frustumCulled={false} renderOrder={-100}>
        <sphereGeometry args={[50, 48, 24]} />
      </mesh>
      <hemisphereLight ref={hemi} args={['#a9c6ff', '#3d4a2c', 1.05]} />
      <directionalLight ref={sun} position={[SUN_DIRECTION.x * 380, SUN_DIRECTION.y * 380 + 50, SUN_DIRECTION.z * 380]} intensity={3.3} color="#fff3e2" castShadow />
      <group ref={site}>
        <group ref={pad}><LaunchPad story={story} /></group>
        <LaunchSmoke nozzle={nozzle} down={down} flight={flight} altitude={altitude} story={story} small={small} />
      </group>
      <group ref={rocket}>
        <LaunchVehicle flight={flight} env={environment.texture} hot={!small} />
      </group>
    </group>
  );
}
