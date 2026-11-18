// The proof chamber (product-plan.md §F): a bounded physical machine, not a progress bar.
// Glyphs have weight, damping and collisions; their count never encodes money, rows, proof bytes or progress.
// The gate is a KINEMATIC collider commanded only by the semantic `gate` prop. Nothing here can sign, fund or
// settle: collision handling has no access to the API or the chain.
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerformanceMonitor } from "@react-three/drei";
import { BallCollider, CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { StaticGate } from "./StaticGate";

export type GateState = "idle" | "locked" | "accepted" | "open" | "rejected";
/** rest: settle. push: drive glyphs at the gate. agitate: indeterminate activity while proving. */
export type Flow = "rest" | "push" | "agitate";

const N = 18;
const R = 0.3;
const GATE_X = 0.4;
const PAD = { x: 3.7, z: 0.2 };
const BAR_Z = Array.from({ length: 9 }, (_, k) => -2.4 + k * 0.6);
const HEADER: Record<GateState, string> = {
  idle: "#cfd3ff",
  locked: "#cfd3ff",
  accepted: "#6bffd8",
  open: "#6bffd8",
  rejected: "#ff6b8b",
};
const BALL_COLORS = ["#f1efe6", "#63f0ff", "#a86bff", "#ff5fd2", "#cfd3ff", "#7d8cff"];

/** Deterministic layout for a reset: the visual arrangement never depends on chain data. */
function spawn(): [number, number, number][] {
  return Array.from({ length: N }, (_, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    return [-4.9 + col * 0.72 + (row % 2) * 0.2, R + 0.02 + (row > 3 ? 0.7 : 0), -2.1 + (row % 4) * 1.35 + col * 0.12];
  });
}

function useCanRender3D(): boolean {
  const [ok] = useState(() => {
    try {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl2") ?? c.getContext("webgl"));
    } catch {
      return false;
    }
  });
  return ok;
}

/** Pause offscreen and in hidden tabs; bodies sleep at rest. */
function useVisible(ref: React.RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [shown, setShown] = useState(!document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setInView(!!e?.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    const vis = () => setShown(!document.hidden);
    document.addEventListener("visibilitychange", vis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, [ref]);
  return inView && shown;
}

function Fit() {
  const { camera, size } = useThree();
  useEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.zoom = Math.min(size.width / 15.2, size.height / 8.6);
    cam.lookAt(0.2, 0.2, 0);
    cam.updateProjectionMatrix();
  }, [camera, size]);
  return null;
}

function Board({ gate }: { gate: GateState }) {
  const padMat = useRef<THREE.MeshStandardMaterial>(null);
  const target = useMemo(() => new THREE.Color(), []);
  useFrame((_, dt) => {
    if (!padMat.current) return;
    target.set(gate === "open" ? "#1f6f66" : "#1b1b33");
    padMat.current.color.lerp(target, Math.min(1, dt * 3));
  });
  return (
    <>
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[6, 0.15, 3]} position={[0, -0.15, 0]} friction={0.5} />
        <CuboidCollider args={[0.1, 1.2, 3]} position={[-6.1, 1.2, 0]} />
        <CuboidCollider args={[0.1, 1.2, 3]} position={[6.1, 1.2, 0]} />
        <CuboidCollider args={[6, 1.2, 0.1]} position={[0, 1.2, -3.1]} />
        <CuboidCollider args={[6, 1.2, 0.1]} position={[0, 1.2, 3.1]} />
        <mesh position={[0, -0.18, 0]} receiveShadow>
          <boxGeometry args={[12.3, 0.36, 6.3]} />
          <meshStandardMaterial color="#11111f" roughness={0.9} />
        </mesh>
      </RigidBody>
      {/* rim */}
      {[
        [0, 0.06, -3.12, 12.3, 0.16, 0.08],
        [0, 0.06, 3.12, 12.3, 0.16, 0.08],
        [-6.12, 0.06, 0, 0.08, 0.16, 6.3],
        [6.12, 0.06, 0, 0.08, 0.16, 6.3],
      ].map(([x, y, z, w, h, d], i) => (
        <mesh key={i} position={[x!, y!, z!]}>
          <boxGeometry args={[w!, h!, d!]} />
          <meshStandardMaterial color="#7d8cff" roughness={0.6} />
        </mesh>
      ))}
      <gridHelper args={[12, 24, "#2a2a44", "#22223a"]} position={[0, 0.005, 0]} scale={[1, 1, 0.5]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[PAD.x, 0.012, PAD.z]} receiveShadow>
        <circleGeometry args={[1.6, 64]} />
        <meshStandardMaterial ref={padMat} color="#1b1b33" roughness={0.8} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[PAD.x, 0.016, PAD.z]}>
        <ringGeometry args={[1.56, 1.64, 64]} />
        <meshBasicMaterial color="#63f0ff" />
      </mesh>
    </>
  );
}

function Gate({ gate }: { gate: GateState }) {
  const bars = useRef<RapierRigidBody>(null);
  const y = useRef(0);
  const header = useRef<THREE.MeshStandardMaterial>(null);
  const barMeshes = useRef<THREE.Group>(null);
  const target = useMemo(() => new THREE.Color(), []);
  useFrame((_, raw) => {
    const dt = Math.min(raw, 0.5);
    const goal = gate === "open" ? -2.4 : 0;
    y.current += (goal - y.current) * Math.min(1, dt * 2.4);
    bars.current?.setNextKinematicTranslation({ x: GATE_X, y: y.current, z: 0 });
    // Fully sunk bars would show under the board; hide them once they are below its surface.
    if (barMeshes.current) barMeshes.current.visible = y.current > -2.2;
    if (header.current) {
      target.set(HEADER[gate]);
      header.current.color.lerp(target, Math.min(1, dt * 4));
    }
  });
  return (
    <>
      {/* Fixed frame: posts and the header beam that carries the gate state colour. */}
      <RigidBody type="fixed" colliders={false} position={[GATE_X, 0, 0]}>
        <CuboidCollider args={[0.18, 1.3, 0.18]} position={[0, 1.3, -2.95]} />
        <CuboidCollider args={[0.18, 1.3, 0.18]} position={[0, 1.3, 2.95]} />
        {[-2.95, 2.95].map((z) => (
          <mesh key={z} position={[0, 1.3, z]} castShadow>
            <boxGeometry args={[0.36, 2.6, 0.36]} />
            <meshStandardMaterial color="#3b3b5c" roughness={0.6} />
          </mesh>
        ))}
        <mesh position={[0, 2.66, 0]} castShadow>
          <boxGeometry args={[0.46, 0.22, 6.3]} />
          <meshStandardMaterial color="#3b3b5c" roughness={0.6} />
        </mesh>
        <mesh position={[0, 2.84, 0]} castShadow>
          <boxGeometry args={[0.34, 0.16, 3.4]} />
          <meshStandardMaterial ref={header} color={HEADER.idle} roughness={0.4} />
        </mesh>
      </RigidBody>
      {/* Moving bars: one kinematic body. Gaps (0.48) are narrower than a glyph (0.6), so a closed gate blocks. */}
      <RigidBody ref={bars} type="kinematicPosition" colliders={false} position={[GATE_X, 0, 0]}>
        <group ref={barMeshes}>
        {BAR_Z.map((z) => (
          <group key={z}>
            <CuboidCollider args={[0.06, 1.1, 0.06]} position={[0, 1.1, z]} />
            <mesh position={[0, 1.1, z]} castShadow>
              <boxGeometry args={[0.12, 2.2, 0.12]} />
              <meshStandardMaterial color="#b9bdf0" roughness={0.5} />
            </mesh>
          </group>
        ))}
        <mesh position={[0, 2.25, 0]}>
          <boxGeometry args={[0.16, 0.1, 5.0]} />
          <meshStandardMaterial color="#8f93d6" roughness={0.5} />
        </mesh>
        </group>
      </RigidBody>
    </>
  );
}

function Glyphs({ gate, flow, resetKey, interactive }: { gate: GateState; flow: Flow; resetKey: number; interactive: boolean }) {
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  const dragging = useRef<number | null>(null);
  const kicked = useRef(false);
  const start = useMemo(spawn, []);
  const { camera, pointer, raycaster } = useThree();
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.7), []);
  const hit = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    kicked.current = false;
  }, [gate]);
  useEffect(() => {
    bodies.current.forEach((b, i) => {
      if (!b) return;
      const [x, y, z] = start[i]!;
      b.setTranslation({ x, y, z }, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    });
  }, [resetKey, start]);
  useEffect(() => {
    const release = () => {
      dragging.current = null;
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

  useFrame(() => {
    const open = gate === "open";
    if (gate === "rejected" && !kicked.current) {
      // One small rebound emphasises the closed gate.
      kicked.current = true;
      bodies.current.forEach((b) => b?.applyImpulse({ x: -1.6 - Math.random() * 0.8, y: 0.4, z: (Math.random() - 0.5) * 0.6 }, true));
    }
    bodies.current.forEach((b, i) => {
      if (!b) return;
      const p = b.translation();
      const v = b.linvel();
      let fx = 0;
      let fy = 0;
      let fz = 0;
      if (open) {
        if (p.x < GATE_X + 0.9) {
          fx = 5;
          fz = -p.z * 0.6;
        } else {
          fx = (PAD.x - p.x) * 2.6;
          fz = (PAD.z - p.z) * 2.6;
        }
      } else if (flow === "push" && gate !== "rejected") {
        fx = 4.2;
      } else if (flow === "agitate") {
        fx = (Math.random() - 0.5) * 7;
        fz = (Math.random() - 0.5) * 7;
        if (Math.random() < 0.01) b.applyImpulse({ x: 0, y: 1.2, z: 0 }, true);
      }
      if (dragging.current === i) {
        raycaster.setFromCamera(pointer, camera);
        if (raycaster.ray.intersectPlane(plane, hit)) {
          fx = (hit.x - p.x) * 38 - v.x * 7;
          fz = (hit.z - p.z) * 38 - v.z * 7;
          fy = (0.9 - p.y) * 24 - v.y * 5;
          const mag = Math.hypot(fx, fy, fz);
          if (mag > 70) {
            fx *= 70 / mag;
            fy *= 70 / mag;
            fz *= 70 / mag;
          }
        }
      }
      // Persistent forces are integrated by the fixed-step solver, so behaviour is frame-rate independent.
      b.resetForces(false);
      if (fx || fy || fz) b.addForce({ x: fx, y: fy, z: fz }, true);
    });
  });

  return (
    <>
      {start.map((pos, i) => (
        <RigidBody
          key={i}
          ref={(b) => {
            bodies.current[i] = b;
          }}
          position={pos}
          colliders={false}
          linearDamping={1.5}
          angularDamping={0.8}
          canSleep
        >
          <BallCollider args={[R]} mass={1} restitution={0.32} friction={0.5} />
          <mesh
            castShadow
            onPointerDown={
              interactive
                ? (e) => {
                    e.stopPropagation();
                    dragging.current = i;
                    bodies.current[i]?.wakeUp();
                  }
                : undefined
            }
          >
            <sphereGeometry args={[R, 28, 20]} />
            <meshStandardMaterial color={BALL_COLORS[i % BALL_COLORS.length]} roughness={0.35} metalness={0.05} />
          </mesh>
        </RigidBody>
      ))}
    </>
  );
}

export interface ChamberProps {
  gate: GateState;
  flow: Flow;
  /** Increment to put the glyphs back at their start positions. */
  resetKey?: number;
  paused?: boolean;
  interactive?: boolean;
  status: { tone: "idle" | "busy" | "pass" | "fail"; text: string };
  left?: { title: string; sub: string };
  right?: { title: string; sub: string };
  hint?: string;
  overlay?: ReactNode;
}

export function ProofChamber(p: ChamberProps) {
  const host = useRef<HTMLDivElement>(null);
  const visible = useVisible(host);
  const can3d = useCanRender3D();
  const paused = !!p.paused || !visible;
  // Adaptive quality (plan §I): if frames slow down (e.g. while the prover loads the laptop), drop shadows and DPR.
  const [low, setLow] = useState(false);

  return (
    <div className="chamber-stage" ref={host}>
      {can3d ? (
        <Canvas
          orthographic
          shadows={!low}
          dpr={low ? 1 : [1, 1.5]}
          frameloop={paused ? "demand" : "always"}
          camera={{ position: [9, 9.5, 12], zoom: 60, near: 0.1, far: 100 }}
          style={{ position: "absolute", inset: 0, touchAction: "pan-y" }}
          aria-hidden
        >
          <PerformanceMonitor onDecline={() => setLow(true)} />
          <Fit />
          <ambientLight intensity={0.75} />
          <hemisphereLight args={["#dfe2ff", "#0a0a18", 0.55]} />
          <directionalLight
            position={[-7, 13, 7]}
            intensity={1.6}
            castShadow
            shadow-mapSize={[1024, 1024]}
            shadow-camera-left={-9}
            shadow-camera-right={9}
            shadow-camera-top={7}
            shadow-camera-bottom={-7}
          />
          <Suspense fallback={null}>
            <Physics timeStep={1 / 60} gravity={[0, -9.81, 0]} paused={paused}>
              <Board gate={p.gate} />
              <Gate gate={p.gate} />
              <Glyphs gate={p.gate} flow={p.flow} resetKey={p.resetKey ?? 0} interactive={p.interactive ?? true} />
            </Physics>
          </Suspense>
        </Canvas>
      ) : (
        <StaticGate gate={p.gate} />
      )}
      {p.left && <div className="chamber-label" style={{ left: 40, top: 22 }}>{p.left.title}<span>{p.left.sub}</span></div>}
      {p.right && <div className="chamber-label" style={{ right: 40, top: 22, textAlign: "right" }}>{p.right.title}<span>{p.right.sub}</span></div>}
      {p.overlay}
      <div className={`chamber-status ${p.status.tone}`} role="status" aria-live="polite"><i aria-hidden />{p.status.text}</div>
      {p.hint && <div className="chamber-hint">{p.hint}</div>}
    </div>
  );
}
