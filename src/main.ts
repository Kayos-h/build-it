import './style.css';
import {
  apiRequest, clearSession, getSession, login, setSession,
  type AccessibleModel, type AdminUser, type ModelTransformRecord, type Session,
} from './api';
import { ModelCalibrationEditor, normalizeEditorTransform } from './admin/ModelCalibrationEditor';
import { getSlotDefinitions } from './config/hardware';
import { Assembly } from './core/Assembly';
import { ConfigurationPreview, type PreviewSelection } from './core/ConfigurationPreview';
import type { ComponentInstance } from './core/types';
import type { BoardMountId, BoardMountLayout, FormFactor, Vec3 } from './core/types';
import {
  COMPATIBILITY_NOTES, DEFAULT_CONFIGURATION, FPS_DESCRIPTION, PERFORMANCE_SCENARIO,
  PRODUCT_KINDS, estimatePerformanceWithOptions, getOptionalProductFromOptions,
  resolveConfigurationChangeWithOptions, validateConfigurationWithOptions,
  type HardwareConfiguration, type Product, type ProductKind, type ProductOptionsByKind,
} from './config/products';
import { AssetRepository } from './graphics/AssetRepository';
import { GraphicsViewport } from './graphics/GraphicsViewport';
import { SlotSnappingController } from './interaction/SlotSnappingController';
import { catalog } from './ui/catalog';

const element = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing UI element ${selector}`);
  return result;
};

function startConfigurator(productOptions: ProductOptionsByKind): () => void {
  let configuration: HardwareConfiguration = { ...DEFAULT_CONFIGURATION };
  let preview: ConfigurationPreview | undefined;
  let viewport: GraphicsViewport | undefined;
  let assets: AssetRepository | undefined;
  let interaction: SlotSnappingController | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachFocusKeys: (() => void) | undefined;
  let disposed = false;
  let loadRequest = 0;
  let adjustmentTimer = 0;
  const canvas = element<HTMLCanvasElement>('#viewport');
  let clearFocus = () => { canvas.setAttribute('aria-label', '3D PC preview'); };
  let refreshFocusLabel = () => {};
  const stage = element('#stage');
  const fields = new Map<ProductKind, { row: HTMLElement; select: HTMLSelectElement; detail: HTMLElement }>();
  const list = element('#parts');
  const note = element('#configuration-note');
  const previewState = element('#preview-state');
  const previewMessage = element('#preview-message');
  const retryButton = element<HTMLButtonElement>('#retry-preview');
  const rgb = element<HTMLInputElement>('#rgb');
  type SavedDraft = import('./config/drafts').SavedDraft;
  let savedDrafts: SavedDraft[] = [];
  // Keep native select elements stable: keyboard focus and an open menu survive
  // metadata updates, while every dependent selection is refreshed together.
  for (const item of catalog) {
    const row = document.createElement('div');
    row.className = 'part-field';
    row.dataset.kind = item.kind;
    const label = document.createElement('label');
    label.className = 'field-label';
    label.htmlFor = `part-${item.kind}`;
    const icon = document.createElement('span');
    icon.className = 'part-icon';
    icon.innerHTML = item.icon;
    label.append(icon, document.createTextNode(item.label));
    const wrap = document.createElement('div');
    wrap.className = 'select-wrap';
    const select = document.createElement('select');
    select.id = `part-${item.kind}`;
    select.name = item.kind;
    select.dataset.kind = item.kind;
    select.setAttribute('aria-describedby', `detail-${item.kind}`);
    select.append(new Option('None', ''));
    for (const product of productOptions[item.kind]) {
      // DDR generation belongs in the option itself, so similar kit names are
      // distinguishable before selection as well as in the selected detail line.
      const name = product.kind === 'ram' ? `${product.name} · ${product.memoryType}` : product.name;
      const option = new Option(name, product.id);
      option.title = `${product.detail} · 3D model: ${product.modelPath}`;
      select.append(option);
    }
    select.addEventListener('change', () => changeSelection(item.kind, select.value));
    wrap.append(select);
    const detail = document.createElement('small');
    detail.id = `detail-${item.kind}`;
    detail.className = 'part-detail';
    row.append(label, wrap, detail);
    list.append(row);
    fields.set(item.kind, { row, select, detail });
  }
  element<HTMLFormElement>('#hardware-form').addEventListener('submit', event => event.preventDefault());

  element('#compatibility').title = COMPATIBILITY_NOTES.join(' ');

  const saveDraftButton = element<HTMLButtonElement>('#save-draft');
  const analyzeButton = element<HTMLButtonElement>('#analyze-performance');
  const draftList = element('#draft-list');
  const renderDrafts = (): void => {
    draftList.innerHTML = savedDrafts.length ? savedDrafts.map(draft => `
      <article class="saved-draft" data-draft="${escapeHtml(draft.id)}">
        <button type="button" class="draft-load" data-load-draft="${escapeHtml(draft.id)}" title="Load ${escapeHtml(draft.name)}">
          <strong>${escapeHtml(draft.name)}</strong><small>${PRODUCT_KINDS.filter(kind => draft.state.configuration[kind]).length}/9 parts · ${new Date(draft.updatedAt).toLocaleDateString()}</small>
        </button><button type="button" class="draft-delete" data-delete-draft="${escapeHtml(draft.id)}" aria-label="Delete ${escapeHtml(draft.name)}">×</button>
      </article>`).join('') : '<p class="draft-empty">Your saved builds will appear here.</p>';
    draftList.querySelectorAll<HTMLButtonElement>('[data-load-draft]').forEach(button => button.onclick = () => {
      const draft = savedDrafts.find(item => item.id === button.dataset.loadDraft);
      if (!draft) return;
      configuration = { ...DEFAULT_CONFIGURATION, ...draft.state.configuration };
      rgb.value = draft.state.rgb || '#a7f36b';
      assets?.setRgbColor(rgb.value);
      renderConfiguration();
    });
    draftList.querySelectorAll<HTMLButtonElement>('[data-delete-draft]').forEach(button => button.onclick = () => {
      const draft = savedDrafts.find(item => item.id === button.dataset.deleteDraft);
      if (!draft) return;
      button.disabled = true;
      void apiRequest('/drafts/' + encodeURIComponent(draft.id), { method: 'DELETE', body: { revision: draft.revision } }).then(() => {
        savedDrafts = savedDrafts.filter(item => item.id !== draft.id);
        if (!disposed) renderDrafts();
      }).catch(error => { button.disabled = false; previewMessage.textContent = errorMessage(error); previewState.hidden = false; });
    });
  };
  draftList.textContent = 'Loading saved builds…';
  void apiRequest<{drafts: SavedDraft[]}>('/drafts').then(payload => {
    if (disposed) return;
    savedDrafts = payload.drafts;
    renderDrafts();
  }).catch(error => { if (!disposed) draftList.textContent = 'Could not load saved builds: ' + errorMessage(error); });
  const closeDialog = (dialog: HTMLDialogElement): void => { if (dialog.open) dialog.close(); };
  saveDraftButton.onclick = () => {
    const dialog = element<HTMLDialogElement>('#save-draft-dialog');
    element<HTMLFormElement>('#save-draft-form').reset();
    element<HTMLInputElement>('#draft-name').value = '';
    element('#save-draft-message').textContent = '';
    dialog.showModal();
    element<HTMLInputElement>('#draft-name').focus();
  };
  element<HTMLFormElement>('#save-draft-form').onsubmit = event => {
    event.preventDefault();
    const name = element<HTMLInputElement>('#draft-name').value.trim();
    if (!name) return;
    const submit = element<HTMLButtonElement>('#save-draft-form button[type="submit"]');
    const feedback = element('#save-draft-message');
    submit.disabled = true;
    feedback.textContent = 'Saving…';
    void apiRequest<{draft: SavedDraft}>('/drafts', { body: { name, state: {
      version: 1, configuration: {...configuration}, software: [], rgb: rgb.value, camera: null,
    } } }).then(payload => {
      if (disposed) return;
      savedDrafts.unshift(payload.draft); renderDrafts();
      closeDialog(element<HTMLDialogElement>('#save-draft-dialog'));
    }).catch(error => { feedback.textContent = errorMessage(error); })
      .finally(() => { submit.disabled = false; });
  };
  element<HTMLButtonElement>('#cancel-save-draft').onclick = () => closeDialog(element<HTMLDialogElement>('#save-draft-dialog'));
  analyzeButton.onclick = () => {
    const dialog = element<HTMLDialogElement>('#analysis-dialog');
    const validation = validateConfigurationWithOptions(productOptions, configuration);
    const performance = estimatePerformanceWithOptions(productOptions, configuration);
    const cpu = getOptionalProductFromOptions(productOptions, configuration, 'cpu');
    const gpu = getOptionalProductFromOptions(productOptions, configuration, 'gpu');
    const ram = getOptionalProductFromOptions(productOptions, configuration, 'ram');
    const selected = `${cpu?.name ?? 'CPU not selected'} · ${gpu?.name ?? 'GPU not selected'} · ${ram ? `${ram.capacityGb} GB RAM` : 'RAM not selected'}`;
    element('#analysis-summary').textContent = selected;
    element('#analysis-games').innerHTML = performance.fps.length ? performance.fps.map(item => `<article class="analysis-card"><div><strong>${escapeHtml(item.game)}</strong><span>${escapeHtml(item.preset)}</span></div><b>${item.low}–${item.high} <small>FPS</small></b><small>${item.bottleneck === 'balanced' ? 'Balanced load' : `${item.bottleneck} limited`} · 1080p</small></article>`).join('') : `<p class="analysis-empty">${validation.selectedCount ? 'Select all nine hardware categories to calculate game FPS.' : 'Choose hardware to see estimates for this build.'}</p>`;
    const analysisApps = [
      { name: 'Blender', field: '3D modeling & rendering', ram: 32, vram: 8, cores: 8, source: 'https://www.blender.org/download/requirements/' },
      { name: 'Autodesk AutoCAD', field: 'Engineering & CAD', ram: 32, vram: 8, threads: 8, source: 'https://help.autodesk.com/view/ACD/2026/ENU/?caas=caas%2Fsfdcarticles%2Fsfdcarticles%2FSystem-requirements-for-AutoCAD-2026-including-Specialized-Toolsets.html' },
      { name: 'SOLIDWORKS', field: 'Mechanical engineering & CAD', ram: 32, vram: 8, cores: 4, source: 'https://www.solidworks.com/support/system-requirements' },
      { name: 'Adobe Premiere Pro', field: 'Video editing', ram: 32, vram: 8, cores: 8, source: 'https://helpx.adobe.com/premiere/desktop/get-started/technical-requirements/adobe-premiere-pro-technical-requirements.html' },
      { name: 'Unreal Engine 5', field: '3D & real-time visualization', ram: 32, vram: 8, cores: 4, source: 'https://dev.epicgames.com/documentation/unreal-engine/hardware-and-software-specifications-for-unreal-engine' },
    ];
    const appRows = analysisApps.map(app => {
      const missing = !cpu || !gpu || !ram;
      const specs = `${app.threads ? `${app.threads}+ CPU threads` : `${app.cores}+ CPU cores`} · ${app.ram} GB RAM · ${app.vram} GB VRAM target`;
      const cpuFits = app.threads ? (cpu?.threads ?? 0) >= app.threads : (cpu?.cores ?? 0) >= (app.cores ?? 0);
      const meets = !missing && cpuFits && ram!.capacityGb >= app.ram && gpu!.vramGb >= app.vram;
      const near = !missing && (app.threads ? cpu!.threads >= app.threads / 2 : cpu!.cores >= (app.cores ?? 0) / 2) && ram!.capacityGb >= Math.ceil(app.ram / 2) && gpu!.vramGb >= Math.ceil(app.vram / 2);
      const status = missing ? 'Select CPU, GPU & RAM' : meets ? 'Capacity target met' : near ? 'Usable · below target' : 'Below target';
      return `<article class="analysis-card app-card"><div><strong><a href="${app.source}" target="_blank" rel="noreferrer">${escapeHtml(app.name)} ↗</a></strong><span>${escapeHtml(app.field)}</span></div><b>${status}</b><small>${specs}</small></article>`;
    }).join('');
    element('#analysis-apps').innerHTML = appRows;
    element('#analysis-caveat').textContent = `Workload fit is a capacity-based heuristic from catalog CPU core, memory, and VRAM values, not a benchmark or guarantee. Game FPS: ${FPS_DESCRIPTION} ${PERFORMANCE_SCENARIO}.`;
    dialog.showModal();
  };
  element<HTMLButtonElement>('#close-analysis').onclick = () => closeDialog(element<HTMLDialogElement>('#analysis-dialog'));

  function syncPreviewProducts(): void {
    const selection: PreviewSelection = {};
    for (const item of catalog) {
      const product = getOptionalProductFromOptions(productOptions, configuration, item.kind);
      if (product) selection[item.kind] = {
        id: product.id,
        name: product.name,
        detail: product.detail,
        modelPath: product.modelPath,
        modelTransform: product.modelTransform,
        boardMountLayout: product.kind === 'motherboard' ? product.boardMountLayout : undefined,
        componentPlacements: product.kind === 'motherboard' ? product.componentPlacements : undefined,
        formFactor: product.kind === 'motherboard' ? product.formFactor : undefined,
      };
    }
    preview?.setProducts(selection);
    refreshFocusLabel();
    if (preview) void loadPreview();
  }

  function renderConfiguration(): void {
    const validation = validateConfigurationWithOptions(productOptions, configuration);
    const board = getOptionalProductFromOptions(productOptions, configuration, 'motherboard');
    for (const item of catalog) {
      const field = fields.get(item.kind)!;
      const product = getOptionalProductFromOptions(productOptions, configuration, item.kind);
      field.select.value = product?.id ?? '';
      field.select.title = product ? `${product.name} · ${product.detail}` : 'None';
      field.detail.textContent = product ? `${product.detail} · 3D model: ${product.modelPath.split('/').pop()}` : 'Not selected';
      field.select.setAttribute('aria-invalid', String(validation.issues.some(issue => issue.kind === item.kind && issue.severity === 'error')));
    }
    const compatibility = element('#compatibility');
    const compatibilityDetail = element('#compatibility-detail');
    compatibility.hidden = false;
    compatibilityDetail.hidden = false;
    compatibility.classList.remove('invalid');
    element('.compatibility-mark').textContent = validation.selectedCount ? '✓' : '—';
    element('#compatibility-text').textContent = !validation.selectedCount
      ? 'No parts selected'
      : `${validation.selectedCount} of ${PRODUCT_KINDS.length} categories selected`;
    element('#compatibility-detail').textContent = 'No catalog compatibility restrictions or automatic SKU replacements are enforced.';
    element('#compatibility-detail').title = board
      ? `3D board layout: ${board.formFactor === 'ITX' ? 'Mini-ITX' : board.formFactor}. ${COMPATIBILITY_NOTES[0]}`
      : COMPATIBILITY_NOTES[0];
    syncPreviewProducts();
  }

  function changeSelection(kind: ProductKind, productId: string): void {
    try {
      const result = resolveConfigurationChangeWithOptions(productOptions, configuration, kind, productId);
      configuration = result.configuration;
      renderConfiguration();
      clearTimeout(adjustmentTimer);
      for (const field of fields.values()) field.row.classList.remove('adjusted');
      note.textContent = '';
      note.hidden = true;
    } catch (error) {
      // Invalid catalog IDs are rejected without mutating the displayed configuration.
      renderConfiguration();
      note.textContent = errorMessage(error);
      note.hidden = false;
    }
  }

  async function loadPreview(): Promise<void> {
    if (!preview || disposed) return;
    const request = ++loadRequest;
    previewState.hidden = false;
    previewState.classList.remove('failed');
    previewMessage.textContent = 'Loading 3D preview…';
    retryButton.hidden = true;
    stage.setAttribute('aria-busy', 'true');
    try {
      await preview.load();
      if (disposed || request !== loadRequest) return;
      previewState.hidden = true;
      stage.setAttribute('aria-busy', 'false');
    } catch (error) {
      if (disposed || request !== loadRequest) return;
      stage.setAttribute('aria-busy', 'false');
      previewState.classList.add('failed');
      previewMessage.textContent = `The 3D model could not load. ${errorMessage(error)}`;
      retryButton.hidden = false;
    }
  }

  element('#reset').onclick = () => {
    configuration = { ...DEFAULT_CONFIGURATION };
    clearTimeout(adjustmentTimer);
    for (const field of fields.values()) { field.row.classList.remove('adjusted'); delete field.row.dataset.focused; }
    note.hidden = true;
    note.textContent = '';
    clearFocus();
    renderConfiguration();
    viewport?.setView('home');
  };
  retryButton.onclick = () => void loadPreview();
  rgb.oninput = () => assets?.setRgbColor(rgb.value);
  renderConfiguration();

  // Product selection and estimates stay usable if WebGL is unavailable.
  try {
    viewport = new GraphicsViewport(canvas, stage);
    assets = new AssetRepository(viewport.renderer);
    const repository = assets;
    const assembly = new Assembly(repository.provide, { release: model => repository.release(model) });
    viewport.scene.add(assembly.root);
    preview = new ConfigurationPreview(assembly);
    syncPreviewProducts();
    unsubscribe = assembly.subscribe(() => { stage.dataset.parts = String(assembly.instances.size); });
    stage.dataset.parts = '0';
    let focusedInstanceId: string | null = null;
    clearFocus = () => {
      focusedInstanceId = null;
      canvas.setAttribute('aria-label', '3D PC preview');
      for (const field of fields.values()) delete field.row.dataset.focused;
    };
    refreshFocusLabel = () => {
      const instance = focusedInstanceId ? assembly.instances.get(focusedInstanceId) : undefined;
      if (!instance) { if (focusedInstanceId) clearFocus(); return; }
      const productName = instance.node.userData.productName ?? instance.definition.label;
      const mount = instance.slotId ? assembly.slots.get(instance.slotId)?.label : '';
      canvas.setAttribute('aria-label', `3D PC preview. Focused on ${productName}${mount ? `, ${mount}` : ''}.`);
    };
    const focusPart = (instance: ComponentInstance): void => {
      focusedInstanceId = instance.id;
      viewport?.focus(instance.model);
      for (const [kind, field] of fields) field.row.dataset.focused = String(kind === instance.kind);
      refreshFocusLabel();
    };
    const onFocusKey = (event: KeyboardEvent): void => {
      if ((event.key.toLowerCase() === 'r' || event.key === 'Home') && !event.altKey && !event.ctrlKey && !event.metaKey) {
        clearFocus();
        return;
      }
      if (event.key !== 'Enter' || event.altKey || event.ctrlKey || event.metaKey) return;
      const instances = [...assembly.instances.values()];
      if (!instances.length) return;
      event.preventDefault();
      const index = instances.findIndex(instance => instance.id === focusedInstanceId);
      const next = index < 0 ? (event.shiftKey ? instances.length - 1 : 0)
        : (index + (event.shiftKey ? -1 : 1) + instances.length) % instances.length;
      focusPart(instances[next]);
    };
    canvas.addEventListener('keydown', onFocusKey);
    detachFocusKeys = () => canvas.removeEventListener('keydown', onFocusKey);
    interaction = new SlotSnappingController({
      canvas, camera: viewport.camera, assembly, previewRoot: viewport.scene,
      setControlsEnabled: enabled => { if (viewport) viewport.controls.enabled = enabled; },
      onFocus: focusPart,
    });
    assets.setGlassOpen(true);
    assets.setRgbColor(rgb.value);
  } catch (error) {
    previewState.hidden = true;
    stage.setAttribute('aria-busy', 'false');
    const fallback = element('#fatal-error');
    fallback.hidden = false;
    fallback.textContent = `The 3D preview needs WebGL 2 and hardware acceleration. Hardware selection and FPS estimates are still available. ${errorMessage(error)}`;
    console.error(error);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    loadRequest++;
    clearTimeout(adjustmentTimer);
    unsubscribe?.();
    detachFocusKeys?.();
    interaction?.dispose();
    preview?.dispose();
    viewport?.dispose();
    assets?.dispose();
    window.removeEventListener('pagehide', onPageHide);
  }
  const onPageHide = (event: PageTransitionEvent) => { if (!event.persisted) dispose(); };
  window.addEventListener('pagehide', onPageHide);
  if (import.meta.hot) import.meta.hot.dispose(dispose);
  return dispose;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const root = element<HTMLDivElement>('#app-root');
let cleanupView: (() => void) | undefined;

function navigate(path: string): void {
  if (location.pathname !== path) history.pushState(null, '', path);
  void boot();
}

function resetRoot(view: 'landing' | 'app' | 'admin'): void {
  cleanupView?.();
  cleanupView = undefined;
  document.body.className = `${view}-body`;
  root.className = `${view}-root`;
  root.innerHTML = '';
}

function brandMarkup(): string {
  return '<span class="logo-mark" aria-hidden="true"><span class="logo-cube"></span></span><span class="logo-wordmark"><span>Build</span><span>It</span></span>';
}

function emptyProductOptions(): ProductOptionsByKind {
  return {
    case: [], motherboard: [], cpu: [], cooler: [], ram: [], gpu: [], psu: [], ssd: [], fan: [],
  };
}

function productOptionsFromModels(models: AccessibleModel[]): ProductOptionsByKind {
  const options: Record<ProductKind, Product[]> = {
    case: [], motherboard: [], cpu: [], cooler: [], ram: [], gpu: [], psu: [], ssd: [], fan: [],
  };
  for (const model of models) {
    if (!PRODUCT_KINDS.includes(model.kind as ProductKind)) continue;
    const product = model.product as Product | undefined;
    if (!product || product.kind !== model.kind) continue;
    options[product.kind].push({ ...product, modelPath: modelAssetUrl(model) } as Product);
  }
  return options as unknown as ProductOptionsByKind;
}

function modelAssetUrl(model: AccessibleModel): string {
  return `/api/models/${encodeURIComponent(model.id)}/file?format=${model.modelPath.split('.').pop()?.toLowerCase() ?? 'glb'}`;
}

function renderLanding(): void {
  resetRoot('landing');
  root.innerHTML = `
    <main class="landing-page">
      <section class="landing-hero">
        <canvas id="landing-visual" class="landing-visual" aria-hidden="true"></canvas>
        <nav class="landing-nav" aria-label="Primary">
          <a class="logo" href="/" data-route>${brandMarkup()}</a>
          <div class="landing-actions">
            <button class="ghost-button" type="button" data-auth-mode="login">Sign in</button>
            
          </div>
        </nav>
        <div class="hero-content">
          <div class="hero-copy">
            <p class="eyebrow">Custom 3D PC model workspace</p>
            <h1>BUILD IT</h1>
            <p class="hero-lede">A protected SaaS portal for visual PC configuration, assigned GLB hardware models, and admin-controlled catalog access.</p>
            <div class="hero-cta">
              <button class="solid-button" type="button" data-auth-mode="login">Open your workspace</button>
              <button class="ghost-button" type="button" data-route="/admin/login">Admin portal</button>
            </div>
          </div>
          <section class="auth-panel" aria-label="Account access">
            <p class="eyebrow">Sign in</p>
            <p class="access-note">Use the account provided by your administrator. Contact them for account access or a password reset.</p>
            <form id="auth-form" class="auth-form">
              <label>Email<input id="auth-email" name="email" type="email" autocomplete="email" required /></label>
              <label>Password<input id="auth-password" name="password" type="password" autocomplete="current-password" required /></label>
              <button id="auth-submit" class="solid-button" type="submit">Sign in</button>
              <p id="auth-message" class="form-message" role="status"></p>
            </form>
          </section>
        </div>
      </section>
    </main>
  `;
  const form = element<HTMLFormElement>('#auth-form');
  const email = element<HTMLInputElement>('#auth-email');
  const password = element<HTMLInputElement>('#auth-password');
  const submit = element<HTMLButtonElement>('#auth-submit');
  const message = element('#auth-message');
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-auth-mode]')) {
    button.addEventListener('click', () => email.focus());
  }
  for (const link of root.querySelectorAll<HTMLElement>('[data-route]')) {
    link.addEventListener('click', event => {
      event.preventDefault();
      navigate(link.dataset.route || '/');
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      submit.disabled = true;
      message.textContent = '';
      try {
        const session = await login('/auth/login', email.value, password.value);
        navigate(session.user.role === 'admin' ? '/admin/dashboard' : '/app');
      } catch (error) {
        message.textContent = errorMessage(error);
      } finally {
        submit.disabled = false;
      }
    })();
  });
  cleanupView = startLandingVisual(element<HTMLCanvasElement>('#landing-visual'));
}

function renderAdminLogin(): void {
  resetRoot('admin');
  root.innerHTML = `
    <main class="admin-login-page">
      <section class="admin-login-panel">
        <a class="logo" href="/" data-route>${brandMarkup()}</a>
        <p class="eyebrow">Admin portal</p>
        <h1>Access Control</h1>
        <form id="admin-login-form" class="auth-form">
          <label>Email<input id="admin-email" name="email" type="email" autocomplete="email" required /></label>
          <label>Password<input id="admin-password" name="password" type="password" autocomplete="current-password" required /></label>
          <button id="admin-submit" class="solid-button" type="submit">Sign in</button>
          <p id="admin-login-message" class="form-message" role="status"></p>
        </form>
      </section>
    </main>
  `;
  root.querySelector('[data-route]')?.addEventListener('click', event => {
    event.preventDefault();
    navigate('/');
  });
  const form = element<HTMLFormElement>('#admin-login-form');
  const submit = element<HTMLButtonElement>('#admin-submit');
  const message = element('#admin-login-message');
  form.addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      submit.disabled = true;
      message.textContent = '';
      try {
        await login('/admin/login', element<HTMLInputElement>('#admin-email').value, element<HTMLInputElement>('#admin-password').value);
        navigate('/admin/dashboard');
      } catch (error) {
        message.textContent = errorMessage(error);
      } finally {
        submit.disabled = false;
      }
    })();
  });
}

function renderPasswordReset(session: Session): void {
  resetRoot('admin');
  root.innerHTML = `
    <main class="admin-login-page">
      <section class="admin-login-panel">
        <a class="logo" href="/" data-route>${brandMarkup()}</a>
        <p class="eyebrow">${session.user.forcePasswordReset ? 'Password reset required' : 'Account password'}</p>
        <h1>Update Password</h1>
        <form id="password-reset-form" class="auth-form">
          <label>Current password<input id="current-password" type="password" autocomplete="current-password" required /></label>
          <label>New password<input id="new-password" type="password" autocomplete="new-password" required minlength="8" /></label>
          <label>Confirm password<input id="confirm-password" type="password" autocomplete="new-password" required minlength="8" /></label>
          <button id="password-reset-submit" class="solid-button" type="submit">Update password</button>
          <button id="password-reset-signout" class="ghost-button" type="button">Sign out</button>
          <p id="password-reset-message" class="form-message" role="status"></p>
        </form>
      </section>
    </main>
  `;
  element<HTMLButtonElement>('#password-reset-signout').addEventListener('click', () => {
    clearSession();
    navigate('/');
  });
  element<HTMLFormElement>('#password-reset-form').addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      const message = element('#password-reset-message');
      const submit = element<HTMLButtonElement>('#password-reset-submit');
      const currentPassword = element<HTMLInputElement>('#current-password').value;
      const newPassword = element<HTMLInputElement>('#new-password').value;
      const confirmPassword = element<HTMLInputElement>('#confirm-password').value;
      if (newPassword !== confirmPassword) {
        message.textContent = 'New passwords do not match.';
        return;
      }
      submit.disabled = true;
      message.textContent = '';
      try {
        const updatedSession = await apiRequest<Session>('/auth/password', {
          body: { currentPassword, newPassword },
        });
        setSession(updatedSession);
        navigate(updatedSession.user.role === 'admin' ? '/admin/dashboard' : '/app');
      } catch (error) {
        message.textContent = errorMessage(error);
      } finally {
        submit.disabled = false;
      }
    })();
  });
}

function productAppMarkup(session: Session): string {
  return `
    <header class="portal-topbar">
      <a class="logo" href="/app" data-route>${brandMarkup()}</a>
      <div class="session-bar">
        <span>${escapeHtml(session.user.email)}</span>
        ${session.user.role === 'admin' ? '<button class="ghost-button compact" type="button" data-route="/admin/dashboard">Admin</button>' : ''}
        <button class="ghost-button compact" type="button" id="sign-out">Sign out</button>
      </div>
    </header>
    <header class="app-header">
      <section class="saved-builds" aria-label="Saved drafts">
        <div class="drafts-heading"><span class="metric-label">Saved drafts</span><span class="drafts-hint">Your PC builds</span></div>
        <div id="draft-list" class="draft-list"></div>
      </section>
    </header>
    <main class="workspace">
      <aside class="library" aria-label="Hardware configuration">
        <form id="hardware-form" class="hardware-form" aria-label="Select your PC hardware">
          <div id="parts" class="parts-list"></div>
        </form>
        <div class="configuration-summary">
          <div id="compatibility" class="compatibility" role="status" hidden><span class="compatibility-mark" aria-hidden="true">OK</span><span id="compatibility-text">Checking selections</span></div>
          <p id="compatibility-detail" class="compatibility-detail" hidden></p>
          <p id="configuration-note" class="configuration-note" role="status" hidden></p>
          <div class="summary-bottom"><button id="reset" type="button" class="reset-button" title="Clear all hardware selections and reset the camera">Reset selections <span aria-hidden="true">Reset</span></button></div>
        </div>
      </aside>
      <section id="stage" aria-label="Interactive PC preview" aria-busy="true">
        <canvas id="viewport" tabindex="0" aria-label="3D PC preview" aria-description="Arrow keys pan; Shift and arrow keys rotate. Plus and minus zoom. Enter focuses the next part; Shift and Enter focuses the previous part. R or Home restores the complete view."></canvas>
        <label class="rgb-picker" title="RGB lighting color"><span>RGB</span><input id="rgb" type="color" value="#a7f36b" aria-label="RGB lighting color" /></label>
        <button id="save-draft" class="stage-action save-draft-action" type="button">Save draft</button>
        <button id="analyze-performance" class="stage-action analyze-action" type="button"><span aria-hidden="true">◈</span> Analyze performance</button>
        <div id="preview-state" class="preview-state" role="status"><span class="loader" aria-hidden="true"></span><span id="preview-message">Loading 3D preview...</span><button id="retry-preview" type="button" class="reset-button" hidden>Retry preview</button></div>
        <div id="fatal-error" class="fatal-error" role="alert" hidden></div>
      </section>
    </main>
    <dialog id="save-draft-dialog" class="app-dialog">
      <form id="save-draft-form" class="dialog-card">
        <p class="eyebrow">Save configuration</p><h2>Save this draft</h2>
        <p class="dialog-copy">Give this build a name so you can return to it later.</p>
        <label>Draft name<input id="draft-name" name="name" type="text" maxlength="48" placeholder="e.g. Workstation build" required /></label>
        <p id="save-draft-message" class="form-message" role="status"></p><div class="dialog-actions"><button id="cancel-save-draft" class="ghost-button" type="button">Cancel</button><button class="solid-button" type="submit">Save draft</button></div>
      </form>
    </dialog>
    <dialog id="analysis-dialog" class="app-dialog analysis-dialog">
      <section class="dialog-card analysis-panel">
        <div class="analysis-heading"><div><p class="eyebrow">Build report</p><h2>Performance analysis</h2><p id="analysis-summary" class="dialog-copy"></p></div><button id="close-analysis" class="dialog-close" type="button" aria-label="Close">×</button></div>
        <h3>Games · 1080p</h3><div id="analysis-games" class="analysis-grid"></div>
        <h3>Engineering, editing & 3D apps</h3><div id="analysis-apps" class="analysis-grid app-analysis-grid"></div>
        <p id="analysis-caveat" class="analysis-caveat"></p>
      </section>
    </dialog>
  `;
}

async function renderUserApp(session: Session): Promise<void> {
  resetRoot('app');
  root.innerHTML = productAppMarkup(session);
  bindShellActions();
  try {
    const { models } = await apiRequest<{ models: AccessibleModel[] }>('/models/accessible');
    cleanupView = startConfigurator(productOptionsFromModels(models));
    if (!models.length) {
      element('#configuration-note').textContent = session.user.role === 'admin'
        ? 'Your catalog is empty. Upload a model in the admin portal to start building.'
        : 'No hardware models are assigned yet. Contact your administrator for access.';
      element('#configuration-note').hidden = false;
    }
  } catch (error) {
    cleanupView = startConfigurator(emptyProductOptions());
    element('#configuration-note').textContent = errorMessage(error);
    element('#configuration-note').hidden = false;
  }
}

function bindShellActions(): void {
  element<HTMLButtonElement>('#sign-out').addEventListener('click', () => {
    clearSession();
    navigate('/');
  });
  for (const link of root.querySelectorAll<HTMLElement>('[data-route]')) {
    link.addEventListener('click', event => {
      event.preventDefault();
      navigate(link.dataset.route || link.getAttribute('href') || '/');
    });
  }
}

type AdminSection = 'dashboard' | 'cases' | 'components' | 'upload' | 'editor' | 'settings';
type AdminState = { users: AdminUser[]; models: AccessibleModel[] };
type UploadDraft = {
  kind: ProductKind;
  name: string;
  detail: string;
  powerWatts: string;
  metadata: Record<string, unknown>;
  metadataText: string;
  file: File;
  objectUrl: string;
};

function adminRoute(): { section: AdminSection; modelId?: string } {
  const path = location.pathname;
  if (path.startsWith('/admin/3d-editor/')) return { section: 'editor', modelId: decodeURIComponent(path.slice('/admin/3d-editor/'.length)) };
  if (path === '/admin/cases') return { section: 'cases' };
  if (path === '/admin/components') return { section: 'components' };
  if (path === '/admin/upload') return { section: 'upload' };
  if (path === '/admin/settings') return { section: 'settings' };
  return { section: 'dashboard' };
}

function adminNavItem(path: string, label: string, active: boolean): string {
  return `<button class="admin-nav-item ${active ? 'active' : ''}" type="button" data-route="${path}">${label}</button>`;
}

async function renderAdminDashboard(session: Session): Promise<void> {
  resetRoot('admin');
  const route = adminRoute();
  root.innerHTML = `
    <main class="admin-shell">
      <aside class="admin-sidebar" aria-label="Admin navigation">
        <a class="logo" href="/admin/dashboard" data-route>${brandMarkup()}</a>
        <nav class="admin-nav">
          ${adminNavItem('/admin/dashboard', 'Dashboard', route.section === 'dashboard')}
          ${adminNavItem('/admin/cases', 'Cases', route.section === 'cases')}
          ${adminNavItem('/admin/components', 'Components', route.section === 'components')}
          ${adminNavItem('/admin/upload', 'Upload Model', route.section === 'upload')}
          ${adminNavItem('/admin/settings', 'Settings', route.section === 'settings')}
        </nav>
        <div class="admin-account">
          <span>${escapeHtml(session.user.email)}</span>
          <button class="ghost-button compact" type="button" data-route="/app">App</button>
          <button class="ghost-button compact" type="button" id="sign-out">Sign out</button>
        </div>
      </aside>
      <section class="admin-main" id="admin-page" aria-live="polite">
        <div class="admin-loading">Loading admin data...</div>
      </section>
    </main>
  `;
  bindShellActions();
  const page = element('#admin-page');
  try {
    const state = await apiRequest<AdminState>('/admin/users');
    if (route.section === 'dashboard') renderAdminOverview(session, state);
    if (route.section === 'cases') renderModelManagementPage(session, state, 'cases');
    if (route.section === 'components') renderModelManagementPage(session, state, 'components');
    if (route.section === 'upload') renderModelUploadPage(state);
    if (route.section === 'settings') renderAdminSettings(state);
    if (route.section === 'editor') await renderModelEditorPage(state, route.modelId ?? '');
  } catch (error) {
    page.innerHTML = `<section class="admin-panel"><p class="form-message">${escapeHtml(errorMessage(error))}</p></section>`;
  }
}

function renderAdminOverview(session: Session, state: AdminState): void {
  const page = element('#admin-page');
  const activeUsers = state.users.filter(user => user.active).length;
  const uploadedModels = state.models.filter(model => !model.isBuiltin).length;
  page.innerHTML = `
    <div class="admin-page-head">
      <div><p class="eyebrow">Overview</p><h1>Admin Dashboard</h1></div>
      <button id="refresh-admin" class="ghost-button compact" type="button">Refresh</button>
    </div>
    <section class="admin-stats" aria-label="Platform statistics">
      <div class="stat-tile"><span>Users</span><strong>${state.users.length}</strong></div>
      <div class="stat-tile"><span>Active</span><strong>${activeUsers}</strong></div>
      <div class="stat-tile"><span>Models</span><strong>${state.models.length}</strong></div>
      <div class="stat-tile"><span>Uploaded</span><strong>${uploadedModels}</strong></div>
    </section>
    <section class="admin-panel create-user-panel">
      <div class="panel-heading"><div><p class="eyebrow">User management</p><h2>Create user</h2></div></div>
      <form id="create-user-form" class="admin-form">
        <label>Email<input id="create-email" type="email" autocomplete="off" required /></label>
        <label>Password<input id="create-password" type="password" autocomplete="new-password" required minlength="8" /></label>
        <label>Role<select id="create-role"><option value="user">User</option><option value="admin">Administrator</option></select></label>
        <label>Expires at<input id="create-expires" type="datetime-local" /></label>
        <label class="check-row"><input id="create-force-reset" type="checkbox" checked /> Temporary password: require a change at first login</label>
        <fieldset id="create-models" class="model-checks"><legend>Hardware model access</legend></fieldset>
        <button class="solid-button" type="submit">Create user</button>
        <p id="admin-message" class="form-message" role="status"></p>
      </form>
    </section>
    <section class="admin-panel users-panel">
      <div class="panel-heading"><div><p class="eyebrow">Access audit</p><h2>Users and model entitlements</h2></div></div>
      <div id="users-table" class="users-table" role="table" aria-label="Users and model permissions"></div>
    </section>
  `;
  renderCreateModelChecks(state.models);
  renderUsersTable(state);
  element<HTMLButtonElement>('#refresh-admin').addEventListener('click', () => void renderAdminDashboard(session));
  element<HTMLFormElement>('#create-user-form').addEventListener('submit', event => {
    event.preventDefault();
    void createUserFromForm(session);
  });
}

async function createUserFromForm(session: Session): Promise<void> {
  const message = element('#admin-message');
  message.textContent = '';
  try {
    await apiRequest('/admin/users', {
      body: {
        email: element<HTMLInputElement>('#create-email').value,
        password: element<HTMLInputElement>('#create-password').value,
      role: element<HTMLSelectElement>('#create-role').value,
        expiresAt: localDateToIso(element<HTMLInputElement>('#create-expires').value),
        forcePasswordReset: element<HTMLInputElement>('#create-force-reset').checked,
        modelIds: checkedValues(element('#create-models')),
      },
    });
    element<HTMLFormElement>('#create-user-form').reset();
    message.textContent = 'User created.';
    await renderAdminDashboard(session);
  } catch (error) {
    message.textContent = errorMessage(error);
  }
}

function renderModelManagementPage(session: Session, state: AdminState, pageKind: 'cases' | 'components'): void {
  const page = element('#admin-page');
  const isCases = pageKind === 'cases';
  const models = state.models.filter(model => isCases ? model.kind === 'case' : model.kind !== 'case');
  page.innerHTML = `
    <div class="admin-page-head">
      <div><p class="eyebrow">Model database</p><h1>${isCases ? 'PC Cases' : 'Components'}</h1></div>
      <div class="admin-page-actions">
        <button class="ghost-button compact" type="button" data-route="/admin/upload">Upload model</button>
        <button id="refresh-admin" class="ghost-button compact" type="button">Refresh</button>
      </div>
    </div>
    <section class="admin-panel">
      <div class="panel-heading"><div><p class="eyebrow">Registry</p><h2>${models.length} ${isCases ? 'case' : 'component'} models</h2></div></div>
      <div id="models-database" class="models-database model-card-grid" aria-label="Hardware models"></div>
    </section>
  `;
  renderModelsDatabase(models);
  bindShellActions();
  element<HTMLButtonElement>('#refresh-admin').addEventListener('click', () => void renderAdminDashboard(session));
}

function renderModelUploadPage(state: AdminState): void {
  const page = element('#admin-page');
  const kindOptions = PRODUCT_KINDS.map(kind => `<option value="${kind}">${catalog.find(item => item.kind === kind)?.label ?? kind}</option>`).join('');
  page.innerHTML = `
    <div class="admin-page-head">
      <div><p class="eyebrow">Upload workflow</p><h1>Upload Model</h1></div>
    </div>
    <section class="upload-flow">
      <section class="admin-panel upload-step-panel">
        <div class="panel-heading"><div><p class="eyebrow">Step 1</p><h2>Model details</h2></div></div>
        <form id="create-model-form" class="admin-form upload-draft-form">
          <label>3D file (GLB, embedded glTF, OBJ)<input id="model-file" type="file" accept=".glb,.gltf,.obj,model/gltf-binary,model/gltf+json" required /></label>
          <label>Name<input id="model-name" type="text" autocomplete="off" required /></label>
          <label>Model type<select id="model-kind">${kindOptions}</select></label>
          <label>Details<input id="model-detail" type="text" autocomplete="off" placeholder="Short SKU description" /></label>
          <label>Power watts<input id="model-power" type="number" min="0" step="1" value="0" /></label>
          <label>Metadata JSON<textarea id="model-metadata" rows="4" spellcheck="false" placeholder='{"capacityGb":32,"memoryType":"DDR5"}'></textarea></label>
          <button id="preview-upload-model" class="solid-button" type="submit">Next</button>
          <p id="model-message" class="form-message" role="status"></p>
        </form>
      </section>
      <section id="upload-preview-step" hidden></section>
    </section>
  `;
  bindModelUploadForm(state);
}

function bindModelUploadForm(state: AdminState): void {
  let editor: ModelCalibrationEditor | null = null;
  let draft: UploadDraft | null = null;
  const disposeDraft = () => {
    editor?.dispose();
    editor = null;
    if (draft) URL.revokeObjectURL(draft.objectUrl);
    draft = null;
  };
  cleanupView = disposeDraft;
  element<HTMLFormElement>('#create-model-form').addEventListener('submit', event => {
    event.preventDefault();
    void (async () => {
      const message = element('#model-message');
      message.textContent = '';
      try {
        const file = element<HTMLInputElement>('#model-file').files?.[0];
        if (!file) throw new Error('Choose a .glb, embedded .gltf, or .obj file.');
        if (!file.size || file.size > 50 * 1024 * 1024) throw new Error('Choose a model between 1 byte and 50 MB.');
        if (!/\.(glb|gltf|obj)$/i.test(file.name)) throw new Error('Choose a .glb, embedded .gltf, or .obj file.');
        const metadataText = element<HTMLTextAreaElement>('#model-metadata').value.trim();
        const metadata = metadataFromText(metadataText);
        disposeDraft();
        draft = {
          file,
          objectUrl: URL.createObjectURL(file),
          kind: element<HTMLSelectElement>('#model-kind').value as ProductKind,
          name: element<HTMLInputElement>('#model-name').value.trim() || file.name.replace(/\.(glb|gltf|obj)$/i, ''),
          detail: element<HTMLInputElement>('#model-detail').value.trim() || 'Uploaded 3D hardware model',
          powerWatts: element<HTMLInputElement>('#model-power').value || '0',
          metadata,
          metadataText,
        };
        editor = await renderUploadPreview(state, draft, disposeDraft);
        message.textContent = 'Preview ready. Adjust the model, then upload.';
      } catch (error) {
        message.textContent = errorMessage(error);
      }
    })();
  });
}

async function renderUploadPreview(state: AdminState, draft: UploadDraft, disposeDraft: () => void): Promise<ModelCalibrationEditor> {
  const preview = element('#upload-preview-step');
  const transform = normalizeEditorTransform({ normalization: 'slot-v1' });
  preview.hidden = false;
  preview.innerHTML = `
    <div class="admin-page-head upload-preview-head">
      <div><p class="eyebrow">Step 2</p><h1>Preview & Calibrate</h1></div>
      <button id="finish-upload-model" class="solid-button compact" type="button">Upload model</button>
    </div>
    <section class="editor-layout upload-editor-layout">
      <div class="editor-stage">
        <canvas id="calibration-canvas" aria-label="Uploaded model preview viewport"></canvas>
        <div id="editor-status" class="editor-status" role="status">Loading model...</div>
      </div>
      <aside class="admin-panel editor-inspector">
        <div class="model-meta">
          <strong>${escapeHtml(draft.kind)} / ${escapeHtml(draft.name)}</strong>
          <code>${escapeHtml(draft.file.name)}</code>
          <small>Use the gizmo and numeric fields to calibrate position, rotation, and scale before saving.</small>
        </div>
        <div class="editor-modes" role="toolbar" aria-label="Transform mode">
          <button class="ghost-button compact active" type="button" data-editor-mode="translate">Position</button>
          <button class="ghost-button compact" type="button" data-editor-mode="rotate">Rotation</button>
          <button class="ghost-button compact" type="button" data-editor-mode="scale">Scale</button>
        </div>
        <form id="transform-form" class="admin-form transform-form">
          ${transformRowMarkup('Position', 'position', transform.position, '0.001')}
          ${transformRowMarkup('Rotation', 'rotation', transform.rotation, '0.01')}
          ${transformRowMarkup('Scale', 'scale', transform.scale, '0.001')}
        </form>
        ${exactCoordinatePanelMarkup(transform)}
        ${copyTransformPanelMarkup(state.models, draft.kind)}
        <div class="editor-actions">
          <button id="auto-align" class="ghost-button compact" type="button">Auto align to slot</button>
          <button id="reset-transform" class="ghost-button compact" type="button">Reset transform</button>
          <button id="reset-editor-view" class="ghost-button compact" type="button">Reset view</button>
        </div>
        <p id="transform-message" class="form-message" role="status"></p>
      </aside>
    </section>
  `;
  const model: AccessibleModel = {
    id: 'draft-upload',
    kind: draft.kind,
    name: draft.name,
    detail: draft.detail,
    modelPath: draft.file.name,
    powerWatts: Number(draft.powerWatts) || 0,
    metadata: draft.metadata,
    transform,
    bounds: null,
    product: null,
    isBuiltin: false,
    createdBy: null,
    createdAt: '',
    updatedAt: '',
  };
  const editor = new ModelCalibrationEditor({
    canvas: element<HTMLCanvasElement>('#calibration-canvas'),
    model,
    sourceUrl: draft.objectUrl,
    onChange: syncTransformFields,
    onStatus: message => { element('#editor-status').textContent = message; },
  });
  bindEditorToolbar(editor);
  bindCopyTransformControls(editor, state.models.filter(model => model.kind === draft.kind));
  bindCurrentCoordinateCopyButtons();
  element<HTMLFormElement>('#transform-form').addEventListener('input', () => editor.setTransform({ ...transformFromFields(), normalization: editor.getTransform().normalization }));
  element<HTMLButtonElement>('#auto-align').addEventListener('click', () => editor.autoAlign());
  element<HTMLButtonElement>('#reset-transform').addEventListener('click', () => editor.setTransform({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
  element<HTMLButtonElement>('#reset-editor-view').addEventListener('click', () => editor.resetView());
  element<HTMLButtonElement>('#finish-upload-model').addEventListener('click', () => {
    void finishModelUpload(draft, editor.getTransform(), disposeDraft);
  });
  await editor.load().catch(error => {
    element('#editor-status').textContent = errorMessage(error);
  });
  preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return editor;
}

async function finishModelUpload(draft: UploadDraft, transform: ModelTransformRecord, disposeDraft: () => void): Promise<void> {
  const message = element('#transform-message');
  const submit = element<HTMLButtonElement>('#finish-upload-model');
  message.textContent = '';
  submit.disabled = true;
  try {
    if (!draft.file.size || draft.file.size > 50 * 1024 * 1024) throw new Error('Choose a model smaller than 50 MB.');
    message.textContent = 'Preparing upload…';
    const upload = await apiRequest<{ signedUrl: string; receipt: string }>('/admin/models/upload-url', {
      body: { filename: draft.file.name, size: draft.file.size },
    });
    message.textContent = 'Uploading model…';
    const result = await fetch(upload.signedUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: draft.file });
    if (!result.ok) throw new Error('Model upload failed. Check your connection and try again.');
    message.textContent = 'Checking and saving model…';
    const payload = await apiRequest<{ model: AccessibleModel }>('/admin/models', { body: {
      receipt: upload.receipt, kind: draft.kind, name: draft.name, detail: draft.detail,
      powerWatts: draft.powerWatts, metadata: draft.metadataText, transform: JSON.stringify(transform),
    } });
    message.textContent = 'Model uploaded.';
    disposeDraft();
    navigate(`/admin/3d-editor/${encodeURIComponent(payload.model.id)}`);
  } catch (error) {
    message.textContent = errorMessage(error);
    submit.disabled = false;
  }
}

function metadataFromText(value: string): Record<string, unknown> {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Metadata JSON must be an object.');
  return parsed as Record<string, unknown>;
}

function exactCoordinatePanelMarkup(transform: ModelTransformRecord): string {
  return `
    <section class="exact-coordinate-panel">
      <div class="mini-panel-head"><strong>Exact coordinates</strong><button class="ghost-button compact" type="button" data-copy-current="all">Copy all</button></div>
      ${exactCoordinateRowMarkup('Position', 'position', transform.position)}
      ${exactCoordinateRowMarkup('Rotation', 'rotation', transform.rotation)}
      ${exactCoordinateRowMarkup('Scale', 'scale', transform.scale)}
    </section>
  `;
}

function exactCoordinateRowMarkup(label: string, key: 'position' | 'rotation' | 'scale', values: readonly number[]): string {
  return `
    <div class="exact-coordinate-row">
      <span>${label}</span>
      <code id="exact-${key}">${vectorLiteral(values)}</code>
      <button class="ghost-button compact" type="button" data-copy-current="${key}">Copy</button>
    </div>
  `;
}

function copyTransformPanelMarkup(models: AccessibleModel[], kind: string): string {
  return `
    <section class="copy-transform-panel">
      <div class="mini-panel-head"><strong>Copy from ${escapeHtml(kind)}</strong></div>
      ${models.length ? `
        <label>Source model<select id="copy-source-model">
          ${models.map(model => `<option value="${escapeHtml(model.id)}">${modelLabel(model)}</option>`).join('')}
        </select></label>
        <div class="copy-transform-actions">
          <button class="ghost-button compact" type="button" data-copy-transform="position">Copy position</button>
          <button class="ghost-button compact" type="button" data-copy-transform="rotation">Copy rotation</button>
          <button class="ghost-button compact" type="button" data-copy-transform="scale">Copy scale</button>
          <button class="ghost-button compact" type="button" data-copy-transform="all">Copy all</button>
        </div>
        <div class="copy-transform-actions">
          <button class="ghost-button compact" type="button" data-match-transform="scale" title="Match the source model's visible bounding size">Match size</button>
          <button class="ghost-button compact" type="button" data-match-transform="all" title="Match source rotation, visible bounding size, and bottom-center alignment">Match bounds</button>
        </div>
      ` : `<small>No other ${escapeHtml(kind)} models available.</small>`}
    </section>
  `;
}

function bindEditorToolbar(editor: ModelCalibrationEditor): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-editor-mode]')) {
    button.addEventListener('click', () => {
      for (const item of root.querySelectorAll<HTMLButtonElement>('[data-editor-mode]')) item.classList.remove('active');
      button.classList.add('active');
      const mode = button.dataset.editorMode === 'rotate' ? 'rotate' : button.dataset.editorMode === 'scale' ? 'scale' : 'translate';
      editor.setMode(mode);
    });
  }
}

function bindCopyTransformControls(editor: ModelCalibrationEditor, models: AccessibleModel[]): void {
  const select = root.querySelector<HTMLSelectElement>('#copy-source-model');
  if (!select) return;
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy-transform]')) {
    button.addEventListener('click', () => {
      void (async () => {
        const source = models.find(model => model.id === select.value);
        if (!source) return;
        const mode = button.dataset.copyTransform === 'rotation' || button.dataset.copyTransform === 'scale' || button.dataset.copyTransform === 'all'
          ? button.dataset.copyTransform
          : 'position';
        button.disabled = true;
        setTransformMessage(`Copying ${mode === 'all' ? 'transform' : mode} from ${source.name}...`);
        try {
          if (source.kind === 'gpu' && (mode === 'scale' || mode === 'all')) {
            await editor.matchFromModel(source, mode === 'all' ? 'all' : 'scale');
            setTransformMessage(`Fitted GPU ${mode === 'all' ? 'bounds' : 'size'} from ${source.name} to this card's proportions.`);
          } else {
            editor.transferFromModel(source, mode);
            setTransformMessage(`Copied ${mode === 'all' ? 'transform' : mode} from ${source.name}.`);
          }
        } catch (error) {
          setTransformMessage(errorMessage(error));
        } finally {
          button.disabled = false;
        }
      })();
    });
  }
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-match-transform]')) {
    button.addEventListener('click', () => {
      void (async () => {
        const source = models.find(model => model.id === select.value);
        if (!source) return;
        const mode = button.dataset.matchTransform === 'scale' ? 'scale' : 'all';
        button.disabled = true;
        setTransformMessage(`Matching ${mode === 'all' ? 'bounds' : 'size'} from ${source.name}...`);
        try {
          await editor.matchFromModel(source, mode);
          setTransformMessage(`Matched ${mode === 'all' ? 'bounds' : 'size'} from ${source.name}.`);
        } catch (error) {
          setTransformMessage(errorMessage(error));
        } finally {
          button.disabled = false;
        }
      })();
    });
  }
}

function bindCurrentCoordinateCopyButtons(): void {
  for (const button of root.querySelectorAll<HTMLButtonElement>('[data-copy-current]')) {
    button.addEventListener('click', () => {
      const transform = transformFromFields();
      const key = button.dataset.copyCurrent;
      const value = key === 'all'
        ? JSON.stringify(transform)
        : vectorLiteral(transform[key === 'rotation' ? 'rotation' : key === 'scale' ? 'scale' : 'position']);
      void copyText(value).then(
        () => setTransformMessage('Copied.'),
        () => setTransformMessage(value),
      );
    });
  }
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.append(textarea);
  textarea.select();
  document.execCommand('copy');
  textarea.remove();
}

function renderAdminSettings(state: AdminState): void {
  const page = element('#admin-page');
  const kinds = PRODUCT_KINDS.map(kind => ({
    kind,
    count: state.models.filter(model => model.kind === kind).length,
  }));
  page.innerHTML = `
    <div class="admin-page-head">
      <div><p class="eyebrow">Platform</p><h1>Settings</h1></div>
    </div>
    <section class="admin-panel settings-grid">
      <div class="setting-row"><span>Model categories</span><strong>${PRODUCT_KINDS.length}</strong></div>
      <div class="setting-row"><span>Total model records</span><strong>${state.models.length}</strong></div>
      <div class="setting-row"><span>Uploaded models</span><strong>${state.models.filter(model => !model.isBuiltin).length}</strong></div>
    </section>
    <section class="admin-panel">
      <div class="panel-heading"><div><p class="eyebrow">Registry coverage</p><h2>Models by category</h2></div></div>
      <div class="settings-category-list">
        ${kinds.map(item => `<div><span>${escapeHtml(item.kind)}</span><strong>${item.count}</strong></div>`).join('')}
      </div>
    </section>
  `;
}

async function renderModelEditorPage(state: AdminState, modelId: string): Promise<void> {
  const model = state.models.find(item => item.id === modelId);
  const page = element('#admin-page');
  if (!model) {
    page.innerHTML = `<section class="admin-panel"><p class="form-message">Model not found.</p></section>`;
    return;
  }
  const backPath = model.kind === 'case' ? '/admin/cases' : '/admin/components';
  const transform = modelTransformOf(model);
  const sameKindModels = state.models.filter(item => item.kind === model.kind && item.id !== model.id);
  const formFactorValue = model.metadata.formFactor;
  const formFactor: FormFactor = formFactorValue === 'mATX' || formFactorValue === 'ITX' ? formFactorValue : 'ATX';
  const boardMountLayout = model.kind === 'motherboard' && model.metadata.boardMountLayout && typeof model.metadata.boardMountLayout === 'object'
    ? model.metadata.boardMountLayout as BoardMountLayout : {};
  const boardMounts = model.kind === 'motherboard' ? getSlotDefinitions('motherboard', formFactor, boardMountLayout) : [];
  const componentModels = state.models.filter(item => ['cpu', 'ram', 'gpu', 'ssd'].includes(item.kind));
  const componentPlacements = model.kind === 'motherboard' && model.metadata.componentPlacements && typeof model.metadata.componentPlacements === 'object'
    ? model.metadata.componentPlacements as Record<string, BoardMountLayout> : {};
  page.innerHTML = `
    <div class="admin-page-head">
      <div><p class="eyebrow">3D calibration</p><h1>${escapeHtml(model.name)}</h1></div>
      <div class="admin-page-actions">
        <button class="ghost-button compact" type="button" data-route="${backPath}">Back</button>
        <button id="save-transform" class="solid-button compact" type="button">${model.kind === 'motherboard' ? 'Save model & placements' : 'Save transform'}</button>
      </div>
    </div>
    <section class="editor-layout">
      <div class="editor-stage">
        <canvas id="calibration-canvas" aria-label="3D model calibration viewport"></canvas>
        <div id="editor-status" class="editor-status" role="status">Loading model...</div>
      </div>
      <aside class="admin-panel editor-inspector">
        <div class="model-meta">
          <strong>${modelLabel(model)}</strong>
          <code>${escapeHtml(model.modelPath)}</code>
          ${model.bounds ? `<small>Bounds ${formatVector(model.bounds.size)} m</small>` : '<small>Bounds unavailable</small>'}
        </div>
        <div class="editor-modes" role="toolbar" aria-label="Transform mode">
          <button class="ghost-button compact active" type="button" data-editor-mode="translate">Position</button>
          <button class="ghost-button compact" type="button" data-editor-mode="rotate">Rotation</button>
          <button class="ghost-button compact" type="button" data-editor-mode="scale">Scale</button>
        </div>
        ${model.kind === 'motherboard' ? boardMountEditorMarkup(componentModels, boardMounts) : ''}
        <form id="transform-form" class="admin-form transform-form">
          ${transformRowMarkup('Position', 'position', transform.position, '0.001')}
          ${transformRowMarkup('Rotation', 'rotation', transform.rotation, '0.01')}
          ${transformRowMarkup('Scale', 'scale', transform.scale, '0.001')}
        </form>
        ${exactCoordinatePanelMarkup(transform)}
        ${copyTransformPanelMarkup(sameKindModels, model.kind)}
        <div class="editor-actions">
          <button id="auto-align" class="ghost-button compact" type="button">Auto align to slot</button>
          <button id="reset-transform" class="ghost-button compact" type="button">Reset transform</button>
          <button id="reset-editor-view" class="ghost-button compact" type="button">Reset view</button>
        </div>
        <p id="transform-message" class="form-message" role="status"></p>
      </aside>
    </section>
  `;
  bindShellActions();
  const editor = new ModelCalibrationEditor({
    canvas: element<HTMLCanvasElement>('#calibration-canvas'),
    model: { ...model, transform },
    boardMountLayout,
    componentPlacements,
    onChange: syncTransformFields,
    onComponentPlacementChange: (kind, layout) => {
      if (root.querySelector<HTMLButtonElement>('[data-component-category].active')?.dataset.componentCategory === kind) {
        const category = root.querySelector<HTMLButtonElement>('[data-component-category].active')?.dataset.componentCategory;
        const slotId = category === 'ram'
          ? root.querySelector<HTMLButtonElement>('[data-placement-slot].active')?.dataset.placementSlot as BoardMountId | undefined
          : ({ cpu: 'motherboard:cpu', gpu: 'motherboard:pcie1', ssd: 'motherboard:m2-1' } as Record<string, BoardMountId>)[category ?? ''];
        if (slotId) syncComponentPlacementFields(layout, slotId);
      }
    },
    onStatus: message => { element('#editor-status').textContent = message; },
  });
  cleanupView = () => editor.dispose();
  bindEditorToolbar(editor);
  bindCopyTransformControls(editor, sameKindModels);
  bindCurrentCoordinateCopyButtons();
  element<HTMLFormElement>('#transform-form').addEventListener('input', () => editor.setTransform({ ...transformFromFields(), normalization: editor.getTransform().normalization }));
  element<HTMLButtonElement>('#auto-align').addEventListener('click', () => editor.autoAlign());
  element<HTMLButtonElement>('#reset-transform').addEventListener('click', () => editor.setTransform({ position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }));
  element<HTMLButtonElement>('#reset-editor-view').addEventListener('click', () => editor.resetView());
  element<HTMLButtonElement>('#save-transform').addEventListener('click', () => {
    void saveEditorTransform(state, model.id, editor.getTransform(), model.kind === 'motherboard' ? editor.getComponentPlacements() : undefined);
  });
  await editor.load().catch(error => {
    element('#editor-status').textContent = errorMessage(error);
  });
  if (model.kind === 'motherboard') bindComponentPlacementEditor(editor, componentModels, boardMounts);
}

async function saveEditorTransform(state: AdminState, modelId: string, transform: ModelTransformRecord, componentPlacements?: Record<string, BoardMountLayout>): Promise<void> {
  const message = element('#transform-message');
  message.textContent = '';
  try {
    const payload = await apiRequest<{ model: AccessibleModel }>(`/admin/models/${encodeURIComponent(modelId)}/transform`, {
      method: 'PUT',
      body: { transform },
    });
    let savedModel = payload.model;
    if (componentPlacements) {
      const mounts = await apiRequest<{ model: AccessibleModel }>(`/admin/models/${encodeURIComponent(modelId)}/component-placements`, {
        method: 'PUT', body: { componentPlacements },
      });
      savedModel = mounts.model;
    }
    const index = state.models.findIndex(model => model.id === modelId);
    if (index >= 0) state.models[index] = savedModel;
    message.textContent = componentPlacements ? 'Motherboard model and component placements saved.' : 'Transform saved.';
  } catch (error) {
    message.textContent = errorMessage(error);
  }
}

function boardMountEditorMarkup(models: AccessibleModel[], slots: ReturnType<typeof getSlotDefinitions>): string {
  const kinds = [{ kind: 'cpu', label: 'CPU' }, { kind: 'ram', label: 'RAM' }, { kind: 'gpu', label: 'GPU' }, { kind: 'ssd', label: 'SSD' }];
  const cpuModels = models.filter(item => item.kind === 'cpu');
  return `
    <section class="board-mount-editor">
      <div><p class="eyebrow">Motherboard fit preview</p><strong>Set general component positions</strong><small>Choose CPU, RAM, GPU, or SSD. The preview model is only a visual reference; the saved position applies to every model in that component category on this motherboard.</small></div>
      <div class="board-mount-buttons" role="group" aria-label="Choose component category">
        ${kinds.map((item, index) => `<button type="button" class="board-mount-button ${index === 0 ? 'active' : ''}" data-component-category="${item.kind}" aria-pressed="${index === 0}">${item.label}</button>`).join('')}
      </div>
      <label class="component-model-select">Preview model<select id="component-model-select">${cpuModels.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('') || '<option value="">No CPU models available</option>'}</select></label>
      <div id="component-slot-list" class="component-slot-list" hidden></div>
      <fieldset class="transform-row board-mount-position"><legend>Selected model position · metres</legend>${['X', 'Y', 'Z'].map((axis, index) => `<label>${axis}<input type="number" step="0.001" data-placement-index="${index}" value="0" /></label>`).join('')}</fieldset>
      <small class="mount-editor-tip">Drag the actual component preview or edit its coordinates. RAM slots can be adjusted one by one.</small>
    </section>
  `;
}

function bindComponentPlacementEditor(editor: ModelCalibrationEditor, models: AccessibleModel[], slots: ReturnType<typeof getSlotDefinitions>): void {
  const categoryButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-component-category]')];
  const select = element<HTMLSelectElement>('#component-model-select');
  const slotList = element('#component-slot-list');
  const slotIds = (kind: string): BoardMountId[] => kind === 'cpu' ? ['motherboard:cpu'] : kind === 'gpu' ? ['motherboard:pcie1'] : kind === 'ssd' ? ['motherboard:m2-1'] : slots.filter(slot => slot.accepts.includes('ram')).map(slot => slot.id as BoardMountId);
  const currentCategory = (): string => categoryButtons.find(button => button.classList.contains('active'))?.dataset.componentCategory ?? 'cpu';
  const activeSlot = (): BoardMountId => currentCategory() === 'ram'
    ? (root.querySelector<HTMLButtonElement>('[data-placement-slot].active')?.dataset.placementSlot as BoardMountId | undefined ?? slotIds('ram')[0])
    : slotIds(currentCategory())[0];
  const syncFields = (): void => {
    const kind = currentCategory();
    const placement = editor.getComponentPlacements()[kind]?.[activeSlot()];
    const slot = slots.find(item => item.id === activeSlot());
    syncComponentPlacementFields({ [activeSlot()]: placement ?? { position: slot?.position ?? [0, 0, 0] } }, activeSlot());
  };
  const refreshPreview = (): void => {
    const category = currentCategory();
    const id = activeSlot();
    const model = models.find(item => item.id === select.value && item.kind === category) ?? null;
    if (category === 'ram') {
      slotList.hidden = false;
      slotList.innerHTML = slotIds('ram').map((slotId, index) => `<button type="button" class="board-mount-button ${slotId === id ? 'active' : ''}" data-placement-slot="${slotId}" aria-pressed="${slotId === id}">DIMM ${index + 1}</button>`).join('');
      slotList.querySelectorAll<HTMLButtonElement>('[data-placement-slot]').forEach(button => button.onclick = () => {
        slotList.querySelectorAll<HTMLButtonElement>('[data-placement-slot]').forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
        refreshPreview();
      });
    } else slotList.hidden = true;
    syncFields();
    void editor.setComponentPreview(model, id);
  };
  const setCategory = (button: HTMLButtonElement): void => {
    categoryButtons.forEach(item => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    const kind = button.dataset.componentCategory!;
    const choices = models.filter(item => item.kind === kind);
    select.innerHTML = choices.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('') || `<option value="">No ${escapeHtml(kind.toUpperCase())} models available</option>`;
    refreshPreview();
  };
  categoryButtons.forEach(button => button.onclick = () => setCategory(button));
  select.onchange = refreshPreview;
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-placement-index]')) {
    input.addEventListener('input', () => {
      const kind = currentCategory();
      const position = [...(editor.getActiveComponentPlacement()?.placement[activeSlot()]?.position ?? editor.getComponentPlacements()[kind]?.[activeSlot()]?.position ?? [0, 0, 0])] as [number, number, number];
      const index = Number(input.dataset.placementIndex);
      if (!Number.isInteger(index) || index < 0 || index > 2) return;
      position[index] = Number(input.value);
      if (position.every(Number.isFinite)) editor.setActiveComponentPosition(position);
    });
  }
  refreshPreview();
}

function syncComponentPlacementFields(layout: BoardMountLayout, id: BoardMountId): void {
  const position = layout[id]?.position;
  if (!position) return;
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-placement-index]')) {
    const index = Number(input.dataset.placementIndex);
    if (index >= 0 && index <= 2) input.value = formatNumber(position[index]);
  }
}

function transformRowMarkup(label: string, key: 'position' | 'rotation' | 'scale', values: readonly number[], step: string): string {
  return `
    <fieldset class="transform-row">
      <legend>${label}</legend>
      ${['X', 'Y', 'Z'].map((axis, index) => `
        <label>${axis}<input type="number" step="${step}" data-transform-key="${key}" data-transform-index="${index}" value="${formatNumber(values[index] ?? 0)}" /></label>
      `).join('')}
    </fieldset>
  `;
}

function transformFromFields(): ModelTransformRecord {
  const next: ModelTransformRecord = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-transform-key]')) {
    const key = input.dataset.transformKey as 'position' | 'rotation' | 'scale';
    const index = Number(input.dataset.transformIndex);
    const value = Number(input.value);
    if (!Number.isInteger(index) || index < 0 || index > 2 || !Number.isFinite(value)) continue;
    next[key][index] = key === 'scale' ? Math.max(0.001, value) : value;
  }
  return next;
}

function syncTransformFields(transform: ModelTransformRecord): void {
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-transform-key]')) {
    const key = input.dataset.transformKey as 'position' | 'rotation' | 'scale';
    const index = Number(input.dataset.transformIndex);
    if (!Number.isInteger(index) || index < 0 || index > 2) continue;
    input.value = formatNumber(transform[key][index]);
  }
  syncExactCoordinateReadout(transform);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Number(value.toFixed(6)));
}

function formatVector(value: readonly number[]): string {
  return value.map(formatNumber).join(' × ');
}

function vectorLiteral(value: readonly number[]): string {
  return `[${value.map(formatNumber).join(', ')}]`;
}

function syncExactCoordinateReadout(transform: ModelTransformRecord): void {
  for (const key of ['position', 'rotation', 'scale'] as const) {
    const node = root.querySelector<HTMLElement>(`#exact-${key}`);
    if (node) node.textContent = vectorLiteral(transform[key]);
  }
}

function setTransformMessage(text: string): void {
  const message = root.querySelector<HTMLElement>('#transform-message');
  if (message) message.textContent = text;
}

function modelTransformOf(model: AccessibleModel): ModelTransformRecord {
  return normalizeEditorTransform(model.transform);
}

function renderCreateModelChecks(models: AccessibleModel[]): void {
  const box = element<HTMLFieldSetElement>('#create-models');
  box.innerHTML = '<legend>Hardware access</legend>' + models.map(model => `
    <label class="check-row"><input type="checkbox" value="${escapeHtml(model.id)}" />${modelLabel(model)}</label>
  `).join('');
}

function renderModelsDatabase(models: AccessibleModel[]): void {
  const database = element('#models-database');
  database.innerHTML = `
    ${models.map(model => `
      ${(() => {
        const transform = modelTransformOf(model);
        return `
      <div class="model-db-row model-card">
        <div>
          <strong>${modelLabel(model)}</strong>
          <span>${model.isBuiltin ? 'Built in' : 'Uploaded'}</span>
        </div>
        <code>${escapeHtml(model.modelPath)}</code>
        <small>Position ${formatVector(transform.position)} · Rotation ${formatVector(transform.rotation)} · Scale ${formatVector(transform.scale)}</small>
        <div class="model-card-actions">
          <button class="ghost-button compact" type="button" data-route="/admin/3d-editor/${encodeURIComponent(model.id)}">Edit 3D</button>
          <button class="danger-button compact" type="button" data-delete-model="${escapeHtml(model.id)}">Remove model</button>
        </div>
      </div>
        `;
      })()}
    `).join('')}
  `;
  for (const link of database.querySelectorAll<HTMLElement>('[data-route]')) {
    link.addEventListener('click', event => {
      event.preventDefault();
      navigate(link.dataset.route || '/admin/dashboard');
    });
  }
  for (const button of database.querySelectorAll<HTMLButtonElement>('[data-delete-model]')) {
    button.addEventListener('click', () => {
      const modelId = button.dataset.deleteModel;
      if (!modelId || !window.confirm('Remove this model? Users will lose access to it.')) return;
      button.disabled = true;
      void apiRequest(`/admin/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' })
        .then(() => refreshAdminFromRow())
        .catch(error => { button.disabled = false; window.alert(errorMessage(error)); });
    });
  }
}

function renderUsersTable(state: { users: AdminUser[]; models: AccessibleModel[] }): void {
  const table = element('#users-table');
  table.innerHTML = `
    <div class="table-row table-head" role="row">
      <span>User</span><span>Status</span><span>Expires</span><span>Hardware access</span><span>Actions</span>
    </div>
    ${state.users.map(user => userRowMarkup(user, state.models)).join('')}
  `;
  for (const row of table.querySelectorAll<HTMLElement>('.table-row[data-user-id]')) {
    const userId = Number(row.dataset.userId);
    row.querySelector<HTMLButtonElement>('[data-save]')?.addEventListener('click', () => {
      void saveUserRow(row, userId).then(() => refreshAdminFromRow()).catch(error => setRowMessage(row, errorMessage(error)));
    });
    row.querySelector<HTMLButtonElement>('[data-delete]')?.addEventListener('click', () => {
      void deleteUserRow(userId).then(() => refreshAdminFromRow()).catch(error => setRowMessage(row, errorMessage(error)));
    });
    for (const input of row.querySelectorAll<HTMLInputElement>('.permission-toggle')) {
      input.addEventListener('change', () => {
        void apiRequest('/admin/permissions', {
          method: 'PUT',
          body: { userId, modelIds: checkedValues(row) },
        }).then(() => setRowMessage(row, 'Saved.')).catch(error => setRowMessage(row, errorMessage(error)));
      });
    }
  }
}

async function refreshAdminFromRow(): Promise<void> {
  const session = getSession();
  if (session) await renderAdminDashboard(session);
}

function userRowMarkup(user: AdminUser, models: AccessibleModel[]): string {
  const expiresLocal = isoToLocalDate(user.expiresAt);
  const status = user.active ? 'Active' : 'Expired';
  const assigned = new Set(user.assignedModelIds);
  return `
    <div class="table-row" role="row" data-user-id="${user.id}">
      <div class="user-cell">
        <strong>${escapeHtml(user.email)}</strong>
        <label>Role<select class="role-input" aria-label="Role for ${escapeHtml(user.email)}"><option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option><option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Administrator</option></select></label>
      </div>
      <span class="status-pill ${user.active ? 'active' : 'expired'}">${status}</span>
      <input class="expires-input" type="datetime-local" aria-label="Account expiry" value="${expiresLocal}" />
      <div class="permission-grid">
        ${models.map(model => `
          <label class="check-row"><input class="permission-toggle" type="checkbox" value="${escapeHtml(model.id)}" ${assigned.has(model.id) ? 'checked' : ''} ${user.role === 'admin' ? 'disabled' : ''} />${modelLabel(model)}</label>
        `).join('')}
      </div>
      <div class="row-actions">
        <label>Set new password<input class="new-user-password" type="password" autocomplete="new-password" minlength="8" placeholder="Leave blank to keep password" /></label>
        <label class="check-row"><input class="force-reset-input" type="checkbox" ${user.forcePasswordReset ? 'checked' : ''} />Require password change</label>
        <button class="ghost-button compact" type="button" data-save>Save</button>
        <button class="danger-button compact" type="button" data-delete ${user.id === getSession()?.user.id ? 'disabled' : ''}>Delete</button>
        <small class="row-message" role="status"></small>
      </div>
    </div>
  `;
}

async function saveUserRow(row: HTMLElement, userId: number): Promise<void> {
  await apiRequest(`/admin/users/${userId}`, {
    method: 'PUT',
    body: {
      role: row.querySelector<HTMLSelectElement>('.role-input')?.value,
      password: row.querySelector<HTMLInputElement>('.new-user-password')?.value || undefined,
      expiresAt: localDateToIso(row.querySelector<HTMLInputElement>('.expires-input')?.value ?? ''),
      forcePasswordReset: row.querySelector<HTMLInputElement>('.force-reset-input')?.checked ?? false,
      modelIds: checkedValues(row),
    },
  });
  setRowMessage(row, 'Saved.');
  if (userId === getSession()?.user.id && row.querySelector<HTMLInputElement>('.new-user-password')?.value) { clearSession(); navigate('/admin/login'); }
}

async function deleteUserRow(userId: number): Promise<void> {
  await apiRequest(`/admin/users/${userId}`, { method: 'DELETE' });
}

function setRowMessage(row: HTMLElement, text: string): void {
  const message = row.querySelector<HTMLElement>('.row-message');
  if (message) message.textContent = text;
}

function modelLabel(model: AccessibleModel): string {
  return `${escapeHtml(model.kind)} / ${escapeHtml(model.name)}`;
}

function checkedValues(container: ParentNode): string[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"][value]:checked')].map(input => input.value);
}

function localDateToIso(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function isoToLocalDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]!);
}

function startLandingVisual(canvas: HTMLCanvasElement): () => void {
  const context = canvas.getContext('2d');
  if (!context) return () => {};
  let frame = 0;
  let raf = 0;
  const pointer = { x: 0.62, y: 0.42 };
  const onPointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) / rect.width;
    pointer.y = (event.clientY - rect.top) / rect.height;
  };
  canvas.addEventListener('pointermove', onPointer);
  const resize = () => {
    const ratio = Math.min(devicePixelRatio, 2);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  const draw = () => {
    resize();
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    frame += 0.012;
    context.clearRect(0, 0, width, height);
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#11181b');
    gradient.addColorStop(0.48, '#102022');
    gradient.addColorStop(1, '#171719');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.strokeStyle = '#2d4f4f';
    context.lineWidth = 1;
    for (let i = 0; i < 18; i++) {
      const y = (i / 18) * height + Math.sin(frame + i) * 10;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width * (0.25 + pointer.x * 0.08), y + 28);
      context.lineTo(width, y - 18);
      context.stroke();
    }
    const centerX = width * (0.55 + (pointer.x - 0.5) * 0.05);
    const centerY = height * (0.52 + (pointer.y - 0.5) * 0.05);
    context.save();
    context.translate(centerX, centerY);
    context.rotate(-0.18);
    context.strokeStyle = '#b6f580';
    context.fillStyle = '#101619cc';
    context.lineWidth = 2;
    context.fillRect(-130, -180, 260, 360);
    context.strokeRect(-130, -180, 260, 360);
    context.strokeStyle = '#d6a84f';
    context.strokeRect(-88, -122, 176, 244);
    context.strokeStyle = '#6ad1c9';
    for (let i = 0; i < 7; i++) {
      const x = -62 + i * 21;
      context.beginPath();
      context.moveTo(x, -96);
      context.lineTo(x + Math.sin(frame + i) * 8, 96);
      context.stroke();
    }
    context.restore();
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  return () => {
    cancelAnimationFrame(raf);
    canvas.removeEventListener('pointermove', onPointer);
  };
}

let bootRevision = 0;
async function boot(): Promise<void> {
  const revision = ++bootRevision;
  let session = getSession();
  if (session) {
    try {
      const result = await apiRequest<{ user: Session['user'] }>('/auth/me');
      if (revision !== bootRevision) return;
      session = { token: session.token, user: result.user };
      setSession(session);
    } catch {
      if (revision !== bootRevision) return;
      clearSession(); session = null;
    }
  }
  if (session && location.pathname === '/password') { renderPasswordReset(session); return; }
  if (session?.user.forcePasswordReset) {
    renderPasswordReset(session);
    return;
  }
  if (location.pathname.startsWith('/admin')) {
    if (location.pathname === '/admin/login') {
      if (session?.user.role === 'admin') navigate('/admin/dashboard');
      else renderAdminLogin();
      return;
    }
    if (location.pathname === '/admin') {
      navigate('/admin/dashboard');
      return;
    }
    if (session?.user.role === 'admin') await renderAdminDashboard(session);
    else renderAdminLogin();
    return;
  }
  if (session) {
    if (session.user.role === 'admin' && location.pathname === '/') {
      navigate('/admin/dashboard');
      return;
    }
    await renderUserApp(session);
    return;
  }
  renderLanding();
}

window.addEventListener('popstate', () => void boot());
void boot();
