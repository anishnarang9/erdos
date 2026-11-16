// The escrow vault (React Three Fiber). Everything it does is driven by the confirmed demo stage.
import { Canvas, useFrame } from "@react-three/fiber";
import { Float } from "@react-three/drei";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { stageOf, useDemo, type Stage } from "../lib/store";

const C = { idle: "#566271", money: "#2f8fff", verified: "#3ddc97", locked: "#f5b041", rejected: "#ff5c5c" };

function coreColor(stage: Stage): string {
  if (stage === "paid" || stage === "decrypted" || stage === "submitted") return C.verified;
  if (stage === "rejected") return C.locked;
  if (stage === "funded" || stage === "proving" || stage === "proved" || stage === "funding") return C.money;
  return C.idle;
}

const N = 260;

function Coins({ stage }: { stage: Stage }) {
  const ref = useRef<THREE.Points>(null);
  const seeds = useMemo(() => Array.from({ length: N }, () => ({ r: 1.9 + Math.random() * 0.9, a: Math.random() * Math.PI * 2, y: (Math.random() - 0.5) * 1.6, s: 0.2 + Math.random() * 0.5, t: Math.random() })), []);
  const positions = useMemo(() => new Float32Array(N * 3), []);
  const mode = useRef<"none" | "orbit" | "out-right" | "out-left">("none");
  const progress = useRef(0);
  const want = stage === "funded" || stage === "proving" || stage === "proved" || stage === "submitted" || stage === "rejected" ? "orbit" : stage === "paid" || stage === "decrypted" ? "out-right" : stage === "refunded" ? "out-left" : "none";
  if (want !== mode.current) {
    mode.current = want;
    progress.current = 0;
  }

  useFrame((_, dt) => {
    const pts = ref.current;
    if (!pts) return;
    progress.current = Math.min(1, progress.current + dt * 0.45);
    const p = progress.current;
    for (let i = 0; i < N; i++) {
      const sd = seeds[i]!;
      sd.a += dt * sd.s * (stage === "proving" ? 2.2 : 0.8);
      let x = Math.cos(sd.a) * sd.r;
      let y = sd.y;
      let z = Math.sin(sd.a) * sd.r;
      if (mode.current === "orbit") {
        const inP = Math.min(1, p * 1.5 + sd.t * 0.3);
        x = THREE.MathUtils.lerp(-6, x, inP);
      } else if (mode.current === "out-right" || mode.current === "out-left") {
        const dir = mode.current === "out-right" ? 1 : -1;
        const k = Math.max(0, Math.min(1, p * 1.6 - sd.t * 0.6));
        x = THREE.MathUtils.lerp(x, dir * 7, k * k);
        y = THREE.MathUtils.lerp(y, 0, k);
        z = THREE.MathUtils.lerp(z, 0, k);
      } else {
        x = 99;
      }
      positions.set([x, y, z], i * 3);
    }
    pts.geometry.attributes.position!.needsUpdate = true;
  });

  return (
    <points ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.13} color={C.money} transparent opacity={0.9} blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
}

function ProofChip({ stage }: { stage: Stage }) {
  const ref = useRef<THREE.Mesh>(null);
  const t = useRef(0);
  const visible = stage === "proved" || stage === "submitted" || stage === "rejected";
  useFrame((_, dt) => {
    const m = ref.current;
    if (!m) return;
    t.current = visible ? Math.min(1, t.current + dt * 0.8) : 0;
    const k = 1 - Math.pow(1 - t.current, 3);
    // Proved: hovers by the solver; submitted: flies into the vault; rejected: stops short and shakes.
    const target = stage === "submitted" ? 0 : stage === "rejected" ? 1.6 : 3.4;
    m.position.x = THREE.MathUtils.lerp(4.6, target, k);
    m.position.y = stage === "rejected" ? Math.sin(performance.now() / 40) * 0.04 : 0;
    m.rotation.y += dt * 1.5;
    m.scale.setScalar(stage === "submitted" ? THREE.MathUtils.lerp(1, 0.2, k) : 1);
    m.visible = visible && !(stage === "submitted" && k > 0.98);
  });
  return (
    <mesh ref={ref} visible={false}>
      <boxGeometry args={[0.5, 0.06, 0.36]} />
      <meshStandardMaterial color={stage === "rejected" ? C.rejected : C.verified} emissive={stage === "rejected" ? C.rejected : C.verified} emissiveIntensity={1.4} />
    </mesh>
  );
}

function Core({ stage }: { stage: Stage }) {
  const core = useRef<THREE.Mesh>(null);
  const ring1 = useRef<THREE.Mesh>(null);
  const ring2 = useRef<THREE.Mesh>(null);
  const color = useMemo(() => new THREE.Color(), []);
  const pulse = useRef(0);
  const last = useRef(stage);
  if (last.current !== stage) {
    if (stage === "submitted" || stage === "paid" || stage === "rejected" || stage === "funded") pulse.current = 1;
    last.current = stage;
  }
  useFrame((_, dt) => {
    const speed = stage === "proving" ? 1.6 : stage === "paid" || stage === "decrypted" ? 0.25 : 0.5;
    if (ring1.current) ring1.current.rotation.x += dt * speed;
    if (ring2.current) ring2.current.rotation.y += dt * speed * 0.8;
    pulse.current = Math.max(0, pulse.current - dt * 0.9);
    const m = core.current;
    if (!m) return;
    const mat = m.material as THREE.MeshStandardMaterial;
    const flash = stage === "rejected" && pulse.current > 0.4 ? C.rejected : coreColor(stage);
    color.set(flash);
    mat.color.lerp(color, 0.08);
    mat.emissive.lerp(color, 0.08);
    mat.emissiveIntensity = 0.5 + pulse.current * 2.2;
    m.scale.setScalar(1 + pulse.current * 0.18);
    m.rotation.y += dt * 0.3;
  });
  return (
    <group>
      <mesh ref={core}>
        <icosahedronGeometry args={[0.9, 0]} />
        <meshStandardMaterial color={C.idle} emissive={C.idle} flatShading metalness={0.4} roughness={0.35} />
      </mesh>
      <mesh ref={ring1}>
        <torusGeometry args={[1.45, 0.025, 12, 96]} />
        <meshStandardMaterial color="#9fb3c8" emissive="#2c3b4d" metalness={0.8} roughness={0.2} />
      </mesh>
      <mesh ref={ring2} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.65, 0.02, 12, 96]} />
        <meshStandardMaterial color="#9fb3c8" emissive="#2c3b4d" metalness={0.8} roughness={0.2} />
      </mesh>
    </group>
  );
}

export function Vault3D() {
  const stage = useDemo(stageOf);
  return (
    <Canvas camera={{ position: [0, 0.8, 9], fov: 40 }} dpr={[1, 1.75]} gl={{ antialias: true, powerPreference: "high-performance" }} aria-label={`Escrow vault: ${stage}`}>
      <ambientLight intensity={0.35} />
      <pointLight position={[4, 4, 5]} intensity={40} />
      <pointLight position={[-5, -2, 3]} intensity={18} color={C.money} />
      <Float speed={1.2} rotationIntensity={0.15} floatIntensity={0.4}>
        <Core stage={stage} />
      </Float>
      <Coins stage={stage} />
      <ProofChip stage={stage} />
    </Canvas>
  );
}
