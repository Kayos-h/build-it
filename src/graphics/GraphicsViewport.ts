import {
  ACESFilmicToneMapping, Box3, Color, DirectionalLight, Fog, GridHelper, HalfFloatType,
  HemisphereLight, MathUtils, Mesh, MeshStandardMaterial, PCFSoftShadowMap,
  PerspectiveCamera, PlaneGeometry, PMREMGenerator, Scene, SRGBColorSpace, Vector2,
  Vector3, WebGLRenderer, WebGLRenderTarget, type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export type CameraView = 'home' | 'side' | 'front' | 'top';
interface FocusTween { startPosition: Vector3; startTarget: Vector3; position: Vector3; target: Vector3; elapsed: number }

/** Meter-scale scene, HDR postprocessing, soft shadows, and interruption-safe orbit focus. */
export class GraphicsViewport {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(36, 1, .003, 12);
  readonly renderer: WebGLRenderer;
  readonly controls: OrbitControls;
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private readonly observer: ResizeObserver;
  private readonly frameCallbacks = new Set<(dt: number) => void>();
  private readonly environment: WebGLRenderTarget;
  private readonly floor: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private readonly grid: GridHelper;
  private readonly key: DirectionalLight;
  private tween?: FocusTween;
  private lastFrame = 0;
  private disposed = false;
  private quality: 'high' | 'balanced' = 'high';
  private preset: CameraView | null = 'home';
  private readonly interruptFocus = () => { this.tween = undefined; this.preset = null; };
  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (this.disposed || !this.controls.enabled || event.target !== this.canvas) return;
    // OrbitControls handles arrow-key panning and Shift+arrow rotation. Cancel
    // an active focus transition before its listener applies that navigation.
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.code)) {
      this.interruptFocus();
      return;
    }
    // Keep browser zoom and other modified shortcuts available.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Home' || event.key.toLowerCase() === 'r') {
      event.preventDefault();
      this.interruptFocus();
      this.setView('home');
      return;
    }
    const zoomIn = event.key === '+' || event.key === '=';
    const zoomOut = event.key === '-' || event.key === '_';
    if ((!zoomIn && !zoomOut) || !this.controls.enableZoom) return;
    event.preventDefault();
    this.interruptFocus();
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = offset.length();
    if (distance === 0) return;
    const nextDistance = MathUtils.clamp(distance * (zoomIn ? .9 : 1 / .9), this.controls.minDistance, this.controls.maxDistance);
    this.camera.position.copy(this.controls.target).addScaledVector(offset, nextDistance / distance);
    this.controls.update();
  };

  constructor(private readonly canvas: HTMLCanvasElement, private readonly container: HTMLElement) {
    this.scene.background = new Color(0x0b1216);
    this.scene.fog = new Fog(0x0b1216, 2.5, 5.5);
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.info.autoReset = false;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .075;
    this.controls.minDistance = .17;
    this.controls.maxDistance = 2.3;
    this.controls.maxPolarAngle = Math.PI * .91;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', this.interruptFocus);
    canvas.addEventListener('keydown', this.onKeyDown);
    this.controls.listenToKeyEvents(canvas);

    const pmrem = new PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, .035);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = .65;
    room.dispose(); pmrem.dispose();

    this.scene.add(new HemisphereLight(0xd6e8f4, 0x1d2928, 1.25));
    this.key = new DirectionalLight(0xfff7ef, 3.7);
    this.key.position.set(-.55, 1.25, .8);
    this.key.target.position.set(0, .22, 0);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, { left: -.65, right: .65, top: .7, bottom: -.6, near: .15, far: 2.7 });
    this.key.shadow.camera.updateProjectionMatrix();
    this.key.shadow.bias = -.0001;
    this.key.shadow.normalBias = .0005;
    this.key.shadow.radius = 3;
    this.scene.add(this.key, this.key.target);
    const fill = new DirectionalLight(0x9ccfda, 1.35);
    fill.position.set(.7, .65, -.5);
    this.scene.add(fill);
    const rim = new DirectionalLight(0xa9f4df, .8);
    rim.position.set(-.6, .5, -.8);
    this.scene.add(rim);

    this.floor = new Mesh(new PlaneGeometry(8, 8), new MeshStandardMaterial({ color: 0x0d171b, metalness: .15, roughness: .8 }));
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.position.y = -.004;
    this.floor.receiveShadow = true;
    this.scene.add(this.floor);
    this.grid = new GridHelper(5, 100, 0x29483f, 0x172b29);
    this.grid.position.y = -.003;
    const gridMaterials = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    gridMaterials.forEach(material => { material.transparent = true; material.opacity = .42; });
    this.scene.add(this.grid);

    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // A threshold above diffuse whites restricts glow to HDR emissive RGB emitters.
    this.bloom = new UnrealBloomPass(new Vector2(1, 1), .3, .45, 1.8);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.setView('home', false);
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(time => this.render(time));
  }

  onFrame(callback: (dt: number) => void) {
    this.frameCallbacks.add(callback);
    return () => this.frameCallbacks.delete(callback);
  }

  focus(object: Object3D) {
    this.preset = null;
    object.updateWorldMatrix(true, true);
    const box = new Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const target = box.getCenter(new Vector3());
    const size = box.getSize(new Vector3());
    const limitingTan = Math.tan(MathUtils.degToRad(this.camera.fov / 2)) * Math.min(1, this.camera.aspect);
    const distance = MathUtils.clamp(Math.max(size.x, size.y, size.z) / (2 * limitingTan) * 1.65, .21, 2.1);
    const direction = this.camera.position.clone().sub(this.controls.target).normalize();
    this.move(target.clone().addScaledVector(direction, distance), target);
  }

  setView(view: CameraView, animate = true) {
    this.preset = view;
    const positions: Record<CameraView, Vector3> = {
      home: new Vector3(.73, .5, .91),
      side: new Vector3(.73, .5, .91),
      front: new Vector3(0, .245, 1.17),
      top: new Vector3(.05, 1.38, .02),
    };
    const target = new Vector3(0, .235, 0);
    // Preserve the complete case silhouette when the horizontal field of view
    // becomes narrower than the vertical field on phones and split panels.
    positions[view].sub(target).multiplyScalar(Math.max(1, .9 / this.camera.aspect)).add(target);
    if (animate) this.move(positions[view], target);
    else {
      this.tween = undefined;
      this.camera.position.copy(positions[view]); this.controls.target.copy(target); this.controls.update();
    }
  }

  setQuality(quality: 'high' | 'balanced') {
    this.quality = quality;
    this.bloom.enabled = quality === 'high';
    this.resize();
  }

  private move(position: Vector3, target: Vector3) {
    this.tween = { startPosition: this.camera.position.clone(), startTarget: this.controls.target.clone(), position, target, elapsed: 0 };
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 1.7 : 1.2);
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(width, height, false);
    const aspectChanged = Math.abs(this.camera.aspect - width / height) > .001;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    if (aspectChanged && this.preset) this.setView(this.preset, false);
    this.composer.setPixelRatio(ratio);
    this.composer.setSize(width, height);
  }

  private render(time: number) {
    if (this.disposed) return;
    const dt = Math.min(.05, this.lastFrame ? (time - this.lastFrame) / 1000 : 1 / 60);
    this.lastFrame = time;
    this.controls.update();
    if (this.tween) {
      this.tween.elapsed += dt;
      const t = MathUtils.smootherstep(Math.min(1, this.tween.elapsed / .7), 0, 1);
      this.controls.target.lerpVectors(this.tween.startTarget, this.tween.target, t);
      this.camera.position.lerpVectors(this.tween.startPosition, this.tween.position, t);
      this.camera.lookAt(this.controls.target);
      if (t >= 1) this.tween = undefined;
    }
    this.frameCallbacks.forEach(callback => callback(dt));
    this.renderer.info.reset();
    this.composer.render(dt);
  }

  dispose() {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.canvas.removeEventListener('keydown', this.onKeyDown);
    this.observer.disconnect(); this.controls.removeEventListener('start', this.interruptFocus); this.controls.dispose();
    this.frameCallbacks.clear();
    this.composer.passes.forEach(pass => pass.dispose());
    this.composer.dispose(); this.environment.dispose();
    this.floor.geometry.dispose(); this.floor.material.dispose();
    this.grid.geometry.dispose();
    (Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material]).forEach(material => material.dispose());
    this.key.shadow.map?.dispose(); this.renderer.dispose();
  }
}
