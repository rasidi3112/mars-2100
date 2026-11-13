import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { NOISE_GLSL } from './glsl';
import { EARTH_RADIUS, LAUNCH_LAT, LAUNCH_LON, SUN_DIRECTION } from './approachLive';
import { useGlobeMaps, useSmallScreen } from './earthData';

// Same mapping as SpaceScene.latLonToVector. Duplicated so this file does not
// import the scene that imports it.
function latLonToVector(lat: number, lon: number, radius: number) {
  const u = (lon + 180) / 360;
  const v = (90 - lat) / 180;
  const phi = u * Math.PI * 2;
  const theta = v * Math.PI;
  return new THREE.Vector3(-radius * Math.cos(phi) * Math.sin(theta), radius * Math.cos(theta), radius * Math.sin(phi) * Math.sin(theta));
}

// The Earth seen from space during the transit, from NASA imagery (see earthData.ts):
// Blue Marble for the day side, Black Marble city lights for the night side, and the cloud
// cover of one real day seen by the VIIRS instrument. All three use the same equirectangular
// layout as the Mars globe: 180°W at the left edge. Flat colours stand in until they load.
// Lighting, ocean glint and haze are drawn in shaders: a visual model, not measured data.
// The launch itself is in LaunchSite.

const SITE = latLonToVector(LAUNCH_LAT, LAUNCH_LON, 1).normalize();
const ALIGN_Q = new THREE.Quaternion().setFromUnitVectors(SITE, new THREE.Vector3(0, 1, 0.08).normalize());

export function alignEarth(group: THREE.Object3D) {
  // Turn the launch coast toward the camera as the transit begins.
  group.quaternion.copy(ALIGN_Q);
}

// ---------- Earth surface ----------

const earthVertex = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosO;
  void main() {
    vUv = uv;
    vPosO = position;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vPosW = world.xyz;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const earthFragment = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uNight;
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  uniform vec3 uSunO;
  uniform float uRadius;
  uniform float uScale;
  uniform int uOctaves;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosO;
  ${NOISE_GLSL}
  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(cameraPosition - vPosW);
    vec3 L = normalize(uSun);
    vec3 albedo = texture2D(uMap, vUv).rgb;

    // Water is darker and bluer than land or ice in Blue Marble.
    float blueness = albedo.b - max(albedo.r, albedo.g);
    float ocean = smoothstep(0.008, 0.05, blueness) * (1.0 - smoothstep(0.18, 0.34, albedo.g));

    // Fine detail that only shows close up, so the map does not look soft near the globe.
    vec3 p = vPosO / uRadius;
    float dist = length(cameraPosition - vPosW) / max(uScale, 0.0001);
    float near = 1.0 - smoothstep(uRadius * 0.25, uRadius * 1.1, dist);
    if (near > 0.001) {
      float d = fbm(p * 260.0, uOctaves);
      float d2 = vnoise(p * 1400.0);
      float landDetail = 0.8 + 0.42 * (d * 0.75 + d2 * 0.25);
      float waterDetail = 0.94 + 0.12 * vnoise(p * 700.0);
      albedo *= mix(1.0, mix(landDetail, waterDetail, ocean), near);
    }

    float ndl = dot(N, L);
    float day = smoothstep(-0.08, 0.25, ndl);
    float diffuse = clamp(ndl * 0.92 + 0.08, 0.0, 1.0) * day;
    vec3 sunColour = vec3(1.0, 0.95, 0.88) * 2.4;
    // A warm band where the sun is low.
    vec3 lowSun = mix(vec3(1.0, 0.72, 0.55), vec3(1.0), smoothstep(0.0, 0.25, ndl));
    // Cloud shadows: the cloud map, shifted a little toward the sun.
    vec3 po = normalize(vPosO);
    vec3 toSun = normalize(uSunO - po * dot(uSunO, po));
    vec3 ps = normalize(po + toSun * 0.012);
    vec2 uvShadow = vec2(atan(ps.z, -ps.x) / 6.2831853, 0.5 + asin(clamp(ps.y, -1.0, 1.0)) / 3.14159265);
    float shadow = 1.0 - 0.45 * texture2D(uClouds, uvShadow).r;
    vec3 colour = albedo * 1.55 * diffuse * sunColour * lowSun * shadow;

    // Sun glint on water.
    vec3 H = normalize(L + V);
    float nh = max(dot(N, H), 0.0);
    float glint = (pow(nh, 90.0) * 1.6 + pow(nh, 14.0) * 0.08) * ocean * day;
    colour += vec3(1.0, 0.93, 0.8) * glint * 2.0;

    // Air: blue haze toward the limb, lit only on the day side.
    float nv = max(dot(N, V), 0.0);
    float limb = pow(1.0 - nv, 2.6);
    vec3 sky = vec3(0.28, 0.52, 1.0);
    float skyLit = smoothstep(-0.2, 0.45, ndl);
    colour = mix(colour, sky * skyLit * 1.25 * lowSun, clamp(limb * 0.75 + 0.06 * skyLit, 0.0, 0.85));

    // Night side: city lights from Black Marble, and a faint glow so it is not pure black.
    vec3 lights = texture2D(uNight, vUv).rgb;
    float city = smoothstep(0.12, 0.6, max(lights.r, lights.g));
    colour += (vec3(1.0, 0.78, 0.48) * city * 1.6 + lights * 0.05 + albedo * 0.01) * (1.0 - day);

    gl_FragColor = vec4(colour, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------- clouds ----------

const cloudFragment = /* glsl */ `
  uniform sampler2D uClouds;
  uniform vec3 uSun;
  uniform vec3 uSite;
  uniform float uRadius;
  uniform float uScale;
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vPosW;
  varying vec3 vPosO;
  ${NOISE_GLSL}
  void main() {
    vec3 p = normalize(vPosO);
    float cover = texture2D(uClouds, vUv).r;
    // Break up the map's pixels when the camera is close.
    float dist = length(cameraPosition - vPosW) / max(uScale, 0.0001);
    float near = 1.0 - smoothstep(uRadius * 0.25, uRadius * 1.1, dist);
    cover = clamp(cover + (vnoise(p * 180.0) - 0.5) * 0.3 * near * smoothstep(0.05, 0.5, cover), 0.0, 1.0);
    cover = smoothstep(0.08, 0.72, cover);
    // Keep the sky over the pad clear, as it was at launch.
    cover *= 1.0 - smoothstep(0.9975, 0.9997, dot(p, normalize(uSite)));

    vec3 N = normalize(vNormalW);
    vec3 L = normalize(uSun);
    float ndl = dot(N, L);
    float lit = smoothstep(-0.1, 0.5, ndl);
    vec3 lowSun = mix(vec3(1.0, 0.8, 0.68), vec3(1.0), smoothstep(0.0, 0.25, ndl));
    vec3 colour = vec3(1.0) * (0.02 + lit * (1.5 + 0.5 * cover)) * lowSun;
    gl_FragColor = vec4(colour, cover * 0.94);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// ---------- atmosphere rim ----------

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
    float ndl = dot(vNormal, normalize(uSun));
    float lit = smoothstep(-0.25, 0.5, ndl);
    float glow = pow(d, 1.6) * lit * uStrength;
    // Blue on the day side, a thin warm edge at the terminator.
    vec3 tint = mix(vec3(1.0, 0.52, 0.3), vec3(0.42, 0.66, 1.0), smoothstep(-0.05, 0.3, ndl));
    gl_FragColor = vec4(tint * glow, glow);
    #include <colorspace_fragment>
  }
`;

export function EarthLaunch() {
  const { maps } = useGlobeMaps();
  const small = useSmallScreen();
  const group = useRef<THREE.Group>(null);
  const earthMesh = useRef<THREE.Mesh>(null);
  const octaves = small ? 4 : 5;
  const earthMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: earthVertex,
    fragmentShader: earthFragment,
    uniforms: {
      uMap: { value: null as THREE.Texture | null },
      uNight: { value: null as THREE.Texture | null },
      uClouds: { value: null as THREE.Texture | null },
      uSun: { value: SUN_DIRECTION.clone() },
      uSunO: { value: SUN_DIRECTION.clone() },
      uRadius: { value: EARTH_RADIUS },
      uScale: { value: 1 },
      uOctaves: { value: octaves },
    },
  }), [octaves]);
  const cloudMaterial = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: earthVertex,
    fragmentShader: cloudFragment,
    transparent: true,
    depthWrite: false,
    uniforms: {
      uClouds: { value: null as THREE.Texture | null },
      uSun: { value: SUN_DIRECTION.clone() },
      uSite: { value: SITE.clone() },
      uRadius: { value: EARTH_RADIUS },
      uScale: { value: 1 },
    },
  }), []);
  const atmosphere = useMemo(() => new THREE.ShaderMaterial({
    vertexShader: earthAtmosphereVertex,
    fragmentShader: earthAtmosphereFragment,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: {
      uSun: { value: SUN_DIRECTION.clone() },
      uStrength: { value: 1.25 },
      uMax: { value: Math.sqrt(1 - 1 / (1.03 * 1.03)) },
    },
  }), []);
  useEffect(() => {
    earthMaterial.uniforms.uMap.value = maps.day;
    earthMaterial.uniforms.uNight.value = maps.night;
    earthMaterial.uniforms.uClouds.value = maps.clouds;
    cloudMaterial.uniforms.uClouds.value = maps.clouds;
  }, [earthMaterial, cloudMaterial, maps]);
  useEffect(() => () => { atmosphere.dispose(); earthMaterial.dispose(); cloudMaterial.dispose(); }, [atmosphere, earthMaterial, cloudMaterial]);
  const scaleVec = useMemo(() => new THREE.Vector3(), []);
  const inverse = useMemo(() => new THREE.Quaternion(), []);
  useFrame(() => {
    // The group is scaled down during the transit; the close-up detail should follow.
    if (earthMesh.current) {
      earthMesh.current.getWorldScale(scaleVec);
      earthMaterial.uniforms.uScale.value = scaleVec.x;
      cloudMaterial.uniforms.uScale.value = scaleVec.x;
      // Sun direction in the globe's own frame, for the cloud shadows.
      earthMesh.current.getWorldQuaternion(inverse).invert();
      (earthMaterial.uniforms.uSunO.value as THREE.Vector3).copy(SUN_DIRECTION).applyQuaternion(inverse);
    }
  });
  return (
    <group ref={group}>
      <mesh ref={earthMesh} material={earthMaterial}>
        <sphereGeometry args={[EARTH_RADIUS, 256, 160]} />
      </mesh>
      <mesh scale={1.008} material={cloudMaterial}>
        <sphereGeometry args={[EARTH_RADIUS, 128, 80]} />
      </mesh>
      <mesh scale={1.03} material={atmosphere}>
        <sphereGeometry args={[EARTH_RADIUS, 96, 64]} />
      </mesh>
    </group>
  );
}
