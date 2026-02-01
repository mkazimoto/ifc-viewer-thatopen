import * as OBC from "@thatopen/components";
import * as OBCF from "@thatopen/components-front";
import * as BUI from "@thatopen/ui";
import Stats from "stats.js";
import * as THREE from "three";

// ==========================================
// 🌎 Configuração inicial do mundo 3D
// ==========================================

const container = document.getElementById("container")!;
const components = new OBC.Components();
const worlds = components.get(OBC.Worlds);

const world = worlds.create<
  OBC.SimpleScene,
  OBC.OrthoPerspectiveCamera,
  OBCF.PostproductionRenderer
>();

world.scene = new OBC.SimpleScene(components);
world.scene.setup();
world.scene.three.background = new THREE.Color(0xf0f0f0);

world.renderer = new OBCF.PostproductionRenderer(components, container);
world.camera = new OBC.OrthoPerspectiveCamera(components);

await world.camera.controls.setLookAt(50, 30, 50, 0, 0, 0);

components.init();

// Adiciona grid ao mundo
const grids = components.get(OBC.Grids);
const grid = grids.create(world);
grid.material.uniforms.uColor.value = new THREE.Color(0x444466);

// ==========================================
// 📦 Configuração do FragmentsManager
// ==========================================

const fragments = components.get(OBC.FragmentsManager);

// Carrega o worker para processamento de fragmentos
const workerUrl = "https://thatopen.github.io/engine_fragment/resources/worker.mjs";
const fetchedWorker = await fetch(workerUrl);
const workerBlob = await fetchedWorker.blob();
const workerFile = new File([workerBlob], "worker.mjs", {
  type: "text/javascript",
});
const workerObjectUrl = URL.createObjectURL(workerFile);
fragments.init(workerObjectUrl);

// Configura atualização da câmera para os fragmentos
world.camera.controls.addEventListener("update", () => fragments.core.update());

// Quando um modelo é carregado, adiciona à cena
fragments.list.onItemSet.add(async ({ value: model }) => {
  model.useCamera(world.camera.three);
  world.scene.three.add(model.object);
  fragments.core.update(true);
  
  // Ajusta câmera para enquadrar o modelo
  world.camera.controls.fitToSphere(model.object, true);
  
  // Gera automaticamente as plantas de andares e processa filtros
  setTimeout(async () => {
    await generateFloorPlans();
    await processClassifications();
  }, 500); // Pequeno delay para garantir que o modelo foi processado
});

// Remove z-fighting
fragments.core.models.materials.list.onItemSet.add(({ value: material }) => {
  if (!("isLodMaterial" in material && material.isLodMaterial)) {
    material.polygonOffset = true;
    material.polygonOffsetUnits = 1;
    material.polygonOffsetFactor = Math.random();
  }
});

// ==========================================
// 📄 Configuração do IFC Loader
// ==========================================

const ifcLoader = components.get(OBC.IfcLoader);

// Log das classes IFC que serão convertidas
ifcLoader.onIfcImporterInitialized.add((importer) => {
  console.log("Classes IFC disponíveis:", importer.classes);
});

// Configura o web-ifc usando os arquivos WASM locais
await ifcLoader.setup({
  autoSetWasm: false,
  wasm: {
    path: "/",
    absolute: false,
  },
});

// ==========================================
// 📁 Funções de carregamento de arquivos
// ==========================================

let isLoading = false;

// Cria overlay de loading com barra de progresso
const loadingOverlay = document.createElement("div");
loadingOverlay.id = "loading-overlay";
loadingOverlay.innerHTML = `
  <div class="loading-content">
    <div class="loading-spinner"></div>
    <h2 class="loading-title">Carregando modelo...</h2>
    <p class="loading-filename"></p>
    <div class="progress-container">
      <div class="progress-bar">
        <div class="progress-fill"></div>
      </div>
      <span class="progress-text">0%</span>
    </div>
    <p class="loading-status">Processando arquivo IFC</p>
  </div>
`;
loadingOverlay.style.cssText = `
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(0, 0, 0, 0.85);
  display: none;
  justify-content: center;
  align-items: center;
  z-index: 10000;
  backdrop-filter: blur(5px);
`;

// Estilos do conteúdo do loading
const loadingStyles = document.createElement("style");
loadingStyles.textContent = `
  .loading-content {
    text-align: center;
    color: white;
    font-family: Arial, sans-serif;
  }
  
  .loading-spinner {
    width: 60px;
    height: 60px;
    border: 4px solid rgba(188, 241, 36, 0.3);
    border-top: 4px solid #bcf124;
    border-radius: 50%;
    margin: 0 auto 20px;
    animation: spin 1s linear infinite;
  }
  
  @keyframes spin {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }
  
  .loading-title {
    font-size: 24px;
    margin: 0 0 10px;
    color: #bcf124;
  }
  
  .loading-filename {
    font-size: 14px;
    color: #aaa;
    margin: 0 0 20px;
  }
  
  .progress-container {
    width: 300px;
    margin: 0 auto;
  }
  
  .progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 10px;
  }
  
  .progress-fill {
    height: 100%;
    width: 0%;
    background: linear-gradient(90deg, #bcf124, #8bc34a);
    border-radius: 4px;
    transition: width 0.2s ease;
  }
  
  .progress-text {
    font-size: 18px;
    font-weight: bold;
    color: #bcf124;
  }
  
  .loading-status {
    font-size: 12px;
    color: #888;
    margin-top: 15px;
  }

  /* Estilos para filtros */
  .filter-container {
    max-height: 200px;
    overflow-y: auto;
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
    padding: 8px;
  }
  
  .filter-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 4px;
    transition: background 0.2s;
    color: white;
    font-size: 13px;
  }
  
  .filter-item:hover {
    background: rgba(188, 241, 36, 0.1);
  }
  
  .filter-item input {
    accent-color: #bcf124;
    width: 16px;
    height: 16px;
    cursor: pointer;
  }
  
  .filter-item span {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  
  .filter-empty {
    color: #888;
    font-size: 12px;
    font-style: italic;
    display: block;
    text-align: center;
    padding: 10px;
  }
`;
document.head.appendChild(loadingStyles);
document.body.appendChild(loadingOverlay);

function showLoading(filename: string): void {
  const filenameEl = loadingOverlay.querySelector(".loading-filename") as HTMLElement;
  filenameEl.textContent = filename;
  updateProgress(0, "Iniciando...");
  loadingOverlay.style.display = "flex";
}

function hideLoading(): void {
  loadingOverlay.style.display = "none";
}

function updateProgress(progress: number, status?: string): void {
  const progressFill = loadingOverlay.querySelector(".progress-fill") as HTMLElement;
  const progressText = loadingOverlay.querySelector(".progress-text") as HTMLElement;
  const statusEl = loadingOverlay.querySelector(".loading-status") as HTMLElement;
  
  const percent = Math.round(progress * 100);
  progressFill.style.width = `${percent}%`;
  progressText.textContent = `${percent}%`;
  
  if (status) {
    statusEl.textContent = status;
  }
}

async function loadIfcFromFile(file: File): Promise<void> {
  if (isLoading) return;
  
  try {
    isLoading = true;
    showLoading(file.name);
    console.log(`Carregando arquivo: ${file.name}`);
    
    updateProgress(0.05, "Lendo arquivo...");
    const data = await file.arrayBuffer();
    const buffer = new Uint8Array(data);
    
    updateProgress(0.1, "Processando IFC...");
    
    await ifcLoader.load(buffer, false, file.name.replace(".ifc", ""), {
      processData: {
        progressCallback: (progress) => {
          // Mapeia o progresso de 10% a 95%
          const mappedProgress = 0.1 + (progress * 0.85);
          updateProgress(mappedProgress, "Convertendo geometrias...");
          console.log(`Progresso: ${Math.round(progress * 100)}%`);
        },
      },
    });
    
    updateProgress(1, "Concluído!");
    console.log("Modelo IFC carregado com sucesso!");
    
    // Pequeno delay para mostrar 100%
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.error("Erro ao carregar IFC:", error);
    alert("Erro ao carregar o arquivo IFC. Verifique o console.");
  } finally {
    hideLoading();
    isLoading = false;
  }
}

// ==========================================
// 💾 Funções de exportação
// ==========================================

async function downloadFragments(): Promise<void> {
  const [model] = fragments.list.values();
  if (!model) {
    alert("Nenhum modelo carregado para exportar.");
    return;
  }
  
  const fragsBuffer = await model.getBuffer(false);
  const file = new File([fragsBuffer], "model.frag");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function clearModels(): Promise<void> {
  // Remove cada modelo individualmente em vez de dispor o FragmentsManager inteiro
  for (const [id, model] of fragments.list) {
    world.scene.three.remove(model.object);
    fragments.list.delete(id);
  }
  
  // Reinicializa o fragments se necessário
  if (!fragments.core) {
    fragments.init(workerObjectUrl);
  }
  
  console.log("Modelos removidos.");
}

// ==========================================
// 🎨 Interface do usuário
// ==========================================

BUI.Manager.init();

// ==========================================
// 🏢 Views - Plantas de Andares
// ==========================================

const views = components.get(OBC.Views);
views.world = world;

// Classifier para processar andares do IFC
const classifier = components.get(OBC.Classifier);

// Lista de vistas de andares disponíveis
let floorViews: OBC.View[] = [];
let currentViewId: string | null = null;

// Função para gerar plantas dos andares
async function generateFloorPlans(): Promise<void> {
  const [model] = fragments.list.values();
  if (!model) {
    console.warn("Nenhum modelo carregado para gerar plantas.");
    return;
  }

  console.log("🔍 Processando andares do modelo...");

  // Primeiro, classifica os elementos por andar (IfcBuildingStorey)
  await classifier.byIfcBuildingStorey();
  
  const storeyClassification = classifier.list.get("storeys");
  console.log("📊 Classificação de andares:", storeyClassification);

  // Limpa vistas anteriores
  for (const view of floorViews) {
    try {
      views.list.delete(view.id);
    } catch (e) {
      console.warn("Erro ao limpar vista:", e);
    }
  }
  floorViews = [];

  // Obtém a bounding box do modelo para criar vistas manuais
  const box = new THREE.Box3().setFromObject(model.object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  try {
    // Tenta criar vistas a partir dos andares do IFC
    const ifcViews = await views.createFromIfcStoreys({
      world,
      offset: 1.5,
    });

    if (ifcViews.length > 0) {
      floorViews = ifcViews;
      console.log(`📐 ${floorViews.length} plantas de andares IFC geradas:`, floorViews.map(v => v.id));
    }
  } catch (error) {
    console.warn("Não foi possível criar vistas IFC:", error);
  }

  // Se não encontrou andares IFC, cria vistas manuais baseadas na altura
  if (floorViews.length === 0) {
    console.log("⚠️ Criando vistas manuais baseadas na altura do modelo...");
    
    const height = size.y;
    const numFloors = Math.max(1, Math.ceil(height / 3)); // Assume ~3m por andar
    const floorHeight = height / numFloors;

    for (let i = 0; i < numFloors; i++) {
      const elevation = box.min.y + (i * floorHeight) + (floorHeight / 2);
      const floorName = `Nível ${i + 1} (${elevation.toFixed(1)}m)`;
      
      const floorView = views.create(
        new THREE.Vector3(0, -1, 0), // Normal apontando para baixo (vista de cima)
        new THREE.Vector3(center.x, elevation + 1.5, center.z),
        { id: floorName, world }
      );
      
      floorViews.push(floorView);
    }
    
    // Adiciona vista geral de cima
    const topView = views.create(
      new THREE.Vector3(0, -1, 0),
      new THREE.Vector3(center.x, box.max.y + 2, center.z),
      { id: "Vista Superior (Topo)", world }
    );
    floorViews.push(topView);
    
    console.log(`✅ ${floorViews.length} vistas manuais criadas`);
  }

  // Atualiza o dropdown de andares
  updateFloorDropdown();
  updateFloorDropdown();
}

// Atualiza o dropdown com os andares disponíveis
function updateFloorDropdown(): void {
  const dropdown = document.querySelector("#floor-dropdown") as HTMLSelectElement;
  if (!dropdown) return;

  dropdown.innerHTML = '<option value="">-- Selecione um andar --</option>';
  
  for (const view of floorViews) {
    const option = document.createElement("option");
    option.value = view.id;
    option.textContent = view.id;
    dropdown.appendChild(option);
  }
}

// Abre uma vista de planta específica
async function openFloorPlan(viewId: string): Promise<void> {
  if (!viewId) {
    closePlantView();
    return;
  }

  const view = views.list.get(viewId);
  if (!view) {
    console.warn("Vista não encontrada:", viewId);
    console.log("Vistas disponíveis:", Array.from(views.list.keys()));
    return;
  }

  console.log("📐 Abrindo planta:", viewId, view);

  // Fecha vista anterior se houver
  if (currentViewId) {
    views.close(currentViewId);
  }

  // Configura a vista
  view.world = world;
  view.planesEnabled = true;
  view.helpersVisible = false;

  // Abre a nova vista
  views.open(viewId);
  currentViewId = viewId;

  // Muda para câmera ortográfica
  world.camera.projection.set("Orthographic");

  // Esconde o grid na vista de planta
  grid.visible = false;

  // Atualiza os fragmentos
  fragments.core.update(true);

  // Enquadra o modelo na tela
  const [model] = fragments.list.values();
  if (model) {
    const box = new THREE.Box3().setFromObject(model.object);
    const center = box.getCenter(new THREE.Vector3());
    
    // Posiciona a câmera de cima olhando para baixo
    await world.camera.controls.setLookAt(
      center.x, center.y + 100, center.z,  // Posição da câmera (de cima)
      center.x, center.y, center.z,        // Alvo (centro do modelo)
      true
    );

    // Aplica rotação para a planta aparecer correta
    await world.camera.controls.rotate(-0.3, 0, true);
  }
}

// Função para fechar a vista de planta
async function closePlantView(): Promise<void> {
  if (!currentViewId) return;

  views.close(currentViewId);
  currentViewId = null;

  // Mostra o grid novamente
  grid.visible = true;

  // Reseta a câmera para 3D
  world.camera.projection.set("Perspective");
  world.camera.controls.setLookAt(50, 30, 50, 0, 0, 0, true);

  // Atualiza o dropdown
  const dropdown = document.querySelector("#floor-dropdown") as HTMLSelectElement;
  if (dropdown) dropdown.value = "";

  console.log("🔙 Voltou à vista 3D");
}

// ==========================================
// 🔍 Filtros - Por Andar e Tipo
// ==========================================

// Armazena os estados dos filtros
const filterState = {
  storeys: new Map<string, boolean>(),
  categories: new Map<string, boolean>(),
};

// Processa classificações do modelo
async function processClassifications(): Promise<void> {
  const [model] = fragments.list.values();
  if (!model) return;

  console.log("🔍 Processando classificações...");

  // Classifica por andar
  await classifier.byIfcBuildingStorey();
  
  // Classifica por categoria (tipo de objeto)
  await classifier.byCategory();

  console.log("✅ Classificações processadas:", Array.from(classifier.list.keys()));

  // Atualiza UI dos filtros
  updateFilterUI();
}

// Atualiza a interface de filtros
function updateFilterUI(): void {
  const storeyContainer = document.querySelector("#storey-filters") as HTMLElement;
  const categoryContainer = document.querySelector("#category-filters") as HTMLElement;
  
  if (!storeyContainer || !categoryContainer) return;

  // Limpa containers
  storeyContainer.innerHTML = "";
  categoryContainer.innerHTML = "";

  // Obtém classificações (nomes corretos: "Storeys" e "Categories" com inicial maiúscula)
  const storeys = classifier.list.get("Storeys");
  const categories = classifier.list.get("Categories");

  console.log("📊 Andares:", storeys);
  console.log("📊 Categorias:", categories);

  // Cria checkboxes para andares
  if (storeys) {
    for (const [storeyName] of storeys) {
      if (!filterState.storeys.has(storeyName)) {
        filterState.storeys.set(storeyName, true);
      }
      
      const label = document.createElement("label");
      label.className = "filter-item";
      label.innerHTML = `
        <input type="checkbox" data-type="storey" data-name="${storeyName}" 
          ${filterState.storeys.get(storeyName) ? "checked" : ""}>
        <span>${storeyName}</span>
      `;
      storeyContainer.appendChild(label);
    }
  } else {
    storeyContainer.innerHTML = '<span class="filter-empty">Nenhum andar encontrado</span>';
  }

  // Cria checkboxes para categorias
  if (categories) {
    for (const [categoryName] of categories) {
      if (!filterState.categories.has(categoryName)) {
        filterState.categories.set(categoryName, true);
      }
      
      const label = document.createElement("label");
      label.className = "filter-item";
      label.innerHTML = `
        <input type="checkbox" data-type="category" data-name="${categoryName}" 
          ${filterState.categories.get(categoryName) ? "checked" : ""}>
        <span>${categoryName}</span>
      `;
      categoryContainer.appendChild(label);
    }
  } else {
    categoryContainer.innerHTML = '<span class="filter-empty">Nenhuma categoria encontrada</span>';
  }

  // Adiciona event listeners
  document.querySelectorAll('#storey-filters input, #category-filters input').forEach(input => {
    input.addEventListener("change", handleFilterChange);
  });
}

// Manipula mudança nos filtros
async function handleFilterChange(e: Event): Promise<void> {
  const target = e.target as HTMLInputElement;
  const type = target.dataset.type;
  const name = target.dataset.name;
  const checked = target.checked;

  if (!type || !name) return;

  if (type === "storey") {
    filterState.storeys.set(name, checked);
  } else if (type === "category") {
    filterState.categories.set(name, checked);
  }

  await applyFilters();
}

// Aplica os filtros aos fragmentos
async function applyFilters(): Promise<void> {
  const [model] = fragments.list.values();
  if (!model) return;

  console.log("🔄 Aplicando filtros...");

  // Obtém classificações ("Storeys" e "Categories" com inicial maiúscula)
  const storeys = classifier.list.get("Storeys");
  const categories = classifier.list.get("Categories");

  // Primeiro, mostra tudo usando o método correto do fragmento
  const allIds: number[] = [];
  
  // Coleta todos os IDs de todos os andares
  if (storeys) {
    for (const [, groupData] of storeys) {
      const itemsMap = await groupData.get();
      for (const expressIds of Object.values(itemsMap)) {
        const ids = Array.isArray(expressIds) ? expressIds : Array.from(expressIds as Set<number>);
        allIds.push(...ids);
      }
    }
  }
  
  // Mostra todos os elementos
  if (allIds.length > 0) {
    model.setVisible(allIds, true);
  }

  // Oculta elementos de andares desmarcados
  if (storeys) {
    for (const [storeyName, groupData] of storeys) {
      if (!filterState.storeys.get(storeyName)) {
        // Oculta elementos deste andar
        const itemsMap = await groupData.get();
        for (const expressIds of Object.values(itemsMap)) {
          const ids = Array.isArray(expressIds) ? expressIds : Array.from(expressIds as Set<number>);
          model.setVisible(ids, false);
        }
      }
    }
  }

  // Oculta elementos de categorias desmarcadas
  if (categories) {
    for (const [categoryName, groupData] of categories) {
      if (!filterState.categories.get(categoryName)) {
        // Oculta elementos desta categoria
        const itemsMap = await groupData.get();
        for (const expressIds of Object.values(itemsMap)) {
          const ids = Array.isArray(expressIds) ? expressIds : Array.from(expressIds as Set<number>);
          model.setVisible(ids, false);
        }
      }
    }
  }

  // Atualiza a renderização
  fragments.core.update(true);
}

// Seleciona/Deseleciona todos os filtros de um tipo
function toggleAllFilters(type: "storey" | "category", checked: boolean): void {
  const filterMap = type === "storey" ? filterState.storeys : filterState.categories;
  
  for (const key of filterMap.keys()) {
    filterMap.set(key, checked);
  }

  // Atualiza checkboxes
  const selector = type === "storey" ? "#storey-filters input" : "#category-filters input";
  document.querySelectorAll(selector).forEach(input => {
    (input as HTMLInputElement).checked = checked;
  });

  applyFilters();
}

// ==========================================
// ✂️ Clipper - Planos de corte
// ==========================================

const clipper = components.get(OBC.Clipper);
clipper.enabled = true;
clipper.visible = true;

// Configura material e tamanho do plano de corte
clipper.material.color = new THREE.Color(0xbcf124);
clipper.size = 5;

// Estado do modo de criação de plano
let clippingMode = false;

// Double-click para criar/deletar plano de corte
container.addEventListener("dblclick", async () => {
  if (clippingMode) {
    await clipper.create(world);
  }
});

// Tecla Delete para remover plano de corte
window.addEventListener("keydown", async (e) => {
  if (e.key === "Delete" || e.key === "Backspace") {
    if (clipper.list.size > 0) {
      await clipper.delete(world);
    }
  }
});

// Função para criar caixa de corte (6 planos)
let clippingBoxHelper: THREE.BoxHelper | null = null;

async function createClippingBox(): Promise<void> {
  const [model] = fragments.list.values();
  if (!model) {
    alert("Carregue um modelo primeiro para criar a caixa de corte.");
    return;
  }

  // Obtém a bounding box do modelo
  const box = new THREE.Box3().setFromObject(model.object);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  // Margem extra
  const margin = 0.5;

  // Remove helper anterior se existir
  if (clippingBoxHelper) {
    world.scene.three.remove(clippingBoxHelper);
    clippingBoxHelper = null;
  }

  // Cria um Box3 com a margem para visualização
  const visualBox = new THREE.Box3(
    new THREE.Vector3(box.min.x - margin, box.min.y - margin, box.min.z - margin),
    new THREE.Vector3(box.max.x + margin, box.max.y + margin, box.max.z + margin)
  );

  // Cria um mesh temporário para o BoxHelper
  const boxGeometry = new THREE.BoxGeometry(
    size.x + margin * 2,
    size.y + margin * 2,
    size.z + margin * 2
  );
  const boxMesh = new THREE.Mesh(boxGeometry, new THREE.MeshBasicMaterial({ visible: false }));
  boxMesh.position.copy(center);

  // Cria o BoxHelper para visualizar os limites
  clippingBoxHelper = new THREE.BoxHelper(boxMesh, 0xFF0000);
  clippingBoxHelper.material.linewidth = 2;
  world.scene.three.add(clippingBoxHelper);

  // Log dos bounds
  console.log("📦 Bounds da Caixa de Corte:");
  console.log("  Min:", `X: ${(box.min.x - margin).toFixed(2)}, Y: ${(box.min.y - margin).toFixed(2)}, Z: ${(box.min.z - margin).toFixed(2)}`);
  console.log("  Max:", `X: ${(box.max.x + margin).toFixed(2)}, Y: ${(box.max.y + margin).toFixed(2)}, Z: ${(box.max.z + margin).toFixed(2)}`);
  console.log("  Tamanho:", `X: ${(size.x + margin * 2).toFixed(2)}, Y: ${(size.y + margin * 2).toFixed(2)}, Z: ${(size.z + margin * 2).toFixed(2)}`);
  console.log("  Centro:", `X: ${center.x.toFixed(2)}, Y: ${center.y.toFixed(2)}, Z: ${center.z.toFixed(2)}`);

  // Cria os 6 planos de corte (caixa)
  // Plano superior (Y+)
  clipper.createFromNormalAndCoplanarPoint(
    world,
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(center.x, box.max.y + margin, center.z)
  );

  // Plano inferior (Y-)
  clipper.createFromNormalAndCoplanarPoint(
    world,
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(center.x, box.min.y - margin, center.z)
  );

  // Plano frontal (Z+)
  clipper.createFromNormalAndCoplanarPoint(
    world,
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(center.x, center.y, box.max.z + margin)
  );

  // Plano traseiro (Z-)
  clipper.createFromNormalAndCoplanarPoint(
    world,
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(center.x, center.y, box.min.z - margin)
  );

  // Plano direito (X+)
  clipper.createFromNormalAndCoplanarPoint(
    world,
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(box.max.x + margin, center.y, center.z)
  );

  // Plano esquerdo (X-)
  clipper.createFromNormalAndCoplanarPoint(
    world,
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(box.min.x - margin, center.y, center.z)
  );

  console.log("📦 Caixa de corte criada!");
}

// Função para criar o painel de UI
function createPanel(): BUI.Panel {
  // Botão para carregar arquivo local
  const onFileInput = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      await loadIfcFromFile(input.files[0]);
    }
  };

  const panel = document.createElement("bim-panel") as BUI.Panel;
  panel.setAttribute("active", "");
  panel.setAttribute("label", "Visualizador IFC");
  panel.className = "options-menu";

  panel.innerHTML = `
    <bim-panel-section label="📁 Carregar Modelo">
      <bim-label>Selecione um arquivo IFC:</bim-label>
      
      <input 
        id="file-input"
        type="file" 
        accept=".ifc" 
        style="margin-top: 8px; color: white;"
      />
    </bim-panel-section>

    <bim-panel-section label="📷 Câmera">
      <bim-button 
        id="perspective-btn"
        label="Perspectiva" 
        icon="mdi:cube-outline">
      </bim-button>
      
      <bim-button 
        id="orthographic-btn"
        label="Ortográfica" 
        icon="mdi:square-outline">
      </bim-button>
      
      <bim-button 
        id="reset-camera-btn"
        label="Reset Câmera" 
        icon="mdi:camera-retake">
      </bim-button>
    </bim-panel-section>

    <bim-panel-section label="🏢 Plantas de Andares">
      <bim-label>Selecione um andar:</bim-label>
      
      <select 
        id="floor-dropdown"
        style="width: 100%; padding: 8px; margin-top: 4px; border-radius: 4px; background: #2a2a4a; color: white; border: 1px solid #444;">
        <option value="">-- Selecione um andar --</option>
      </select>
      
      <bim-button 
        id="close-floor-btn"
        label="Voltar à Vista 3D" 
        icon="mdi:rotate-3d"
        style="margin-top: 8px">
      </bim-button>
    </bim-panel-section>

    <bim-panel-section label="🔍 Filtro por Andar" collapsed>
      <div style="display: flex; gap: 8px; margin-bottom: 8px;">
        <bim-button id="select-all-storeys" label="Todos" icon="mdi:check-all" style="flex:1"></bim-button>
        <bim-button id="deselect-all-storeys" label="Nenhum" icon="mdi:close" style="flex:1"></bim-button>
      </div>
      <div id="storey-filters" class="filter-container">
        <span class="filter-empty">Carregue um modelo</span>
      </div>
    </bim-panel-section>

    <bim-panel-section label="🏗️ Filtro por Tipo" collapsed>
      <div style="display: flex; gap: 8px; margin-bottom: 8px;">
        <bim-button id="select-all-categories" label="Todos" icon="mdi:check-all" style="flex:1"></bim-button>
        <bim-button id="deselect-all-categories" label="Nenhum" icon="mdi:close" style="flex:1"></bim-button>
      </div>
      <div id="category-filters" class="filter-container">
        <span class="filter-empty">Carregue um modelo</span>
      </div>
    </bim-panel-section>

    <bim-panel-section label="✂️ Planos de Corte">
      <bim-button 
        id="create-box-btn"
        label="Criar Caixa de Corte" 
        icon="mdi:cube-outline">
      </bim-button>
      
      <bim-button 
        id="toggle-planes-btn"
        label="Mostrar/Ocultar Planos" 
        icon="mdi:eye">
      </bim-button>
      
      <bim-button 
        id="delete-planes-btn"
        label="Remover Todos os Planos" 
        icon="mdi:delete-sweep">
      </bim-button>
      
      <bim-label style="margin-top: 8px; font-size: 11px; opacity: 0.7">
        Duplo clique = criar plano
      </bim-label>
      <bim-label style="font-size: 11px; opacity: 0.7">
        Delete/Backspace = remover plano
      </bim-label>
    </bim-panel-section>

    <bim-panel-section label="🔧 Ações">
      <bim-button 
        id="download-btn"
        label="Baixar Fragments" 
        icon="mdi:download">
      </bim-button>
      
      <bim-button 
        id="clear-btn"
        label="Limpar Modelos" 
        icon="mdi:delete">
      </bim-button>
    </bim-panel-section>

    <bim-panel-section label="ℹ️ Instruções" collapsed>
      <bim-label>1. Clique em "Carregar Exemplo" ou escolha um arquivo .ifc</bim-label>
      <bim-label>2. Use o mouse para navegar:</bim-label>
      <bim-label>• Botão esquerdo: Rotacionar</bim-label>
      <bim-label>• Botão direito: Pan</bim-label>
      <bim-label>• Scroll: Zoom</bim-label>
    </bim-panel-section>
  `;

  // Adiciona event listeners
  panel.querySelector("#file-input")?.addEventListener("change", onFileInput);
  panel.querySelector("#perspective-btn")?.addEventListener("click", () => world.camera.projection.set("Perspective"));
  panel.querySelector("#orthographic-btn")?.addEventListener("click", () => world.camera.projection.set("Orthographic"));
  panel.querySelector("#reset-camera-btn")?.addEventListener("click", () => world.camera.controls.setLookAt(50, 30, 50, 0, 0, 0, true));
  panel.querySelector("#download-btn")?.addEventListener("click", downloadFragments);
  panel.querySelector("#clear-btn")?.addEventListener("click", clearModels);

  // Event listeners para planos de corte
  // (Removido toggleClippingBtn)

  panel.querySelector("#create-box-btn")?.addEventListener("click", createClippingBox);

  const togglePlanesBtn = panel.querySelector("#toggle-planes-btn") as BUI.Button;
  togglePlanesBtn?.addEventListener("click", () => {
    clipper.visible = !clipper.visible;
    togglePlanesBtn.label = clipper.visible ? "Ocultar Planos" : "Mostrar Planos";
    togglePlanesBtn.icon = clipper.visible ? "mdi:eye" : "mdi:eye-off";
  });

  panel.querySelector("#delete-planes-btn")?.addEventListener("click", () => {
    clipper.deleteAll();
    console.log("🗑️ Todos os planos de corte removidos");
  });

  // Event listeners para plantas de andares
  panel.querySelector("#close-floor-btn")?.addEventListener("click", closePlantView);
  
  const floorDropdown = panel.querySelector("#floor-dropdown") as HTMLSelectElement;
  floorDropdown?.addEventListener("change", (e) => {
    const target = e.target as HTMLSelectElement;
    openFloorPlan(target.value);
  });

  // Event listeners para filtros
  panel.querySelector("#select-all-storeys")?.addEventListener("click", () => toggleAllFilters("storey", true));
  panel.querySelector("#deselect-all-storeys")?.addEventListener("click", () => toggleAllFilters("storey", false));
  panel.querySelector("#select-all-categories")?.addEventListener("click", () => toggleAllFilters("category", true));
  panel.querySelector("#deselect-all-categories")?.addEventListener("click", () => toggleAllFilters("category", false));

  return panel;
}

const panel = createPanel();
document.body.append(panel);

// Botão para toggle do menu em mobile
const menuButton = document.createElement("bim-button") as BUI.Button;
menuButton.className = "phone-menu-toggler";
menuButton.icon = "mdi:menu";
menuButton.addEventListener("click", () => {
  if (panel.classList.contains("options-menu-visible")) {
    panel.classList.remove("options-menu-visible");
  } else {
    panel.classList.add("options-menu-visible");
  }
});

document.body.append(menuButton);

// ==========================================
// 📊 Monitor de performance
// ==========================================

const stats = new Stats();
stats.showPanel(0); // 0: fps, 1: ms, 2: mb
stats.dom.style.left = "0px";
stats.dom.style.top = "0px";
stats.dom.style.zIndex = "1000";
document.body.append(stats.dom);

world.renderer.onBeforeUpdate.add(() => stats.begin());
world.renderer.onAfterUpdate.add(() => stats.end());

// ==========================================
// 🖱️ Highlighter - Seleção ao clicar
// ==========================================

const highlighter = components.get(OBCF.Highlighter);
highlighter.setup({ world });

// Configura cor de seleção (azul escuro)
highlighter.config.selectionColor = new THREE.Color(0x1a237e);

// Ativa destaque automático ao clicar
highlighter.config.autoHighlightOnClick = true;

// Elemento para exibir informações do objeto selecionado
const selectionInfo = document.createElement("div");
selectionInfo.id = "selection-info";
selectionInfo.style.cssText = `
  position: fixed;
  bottom: 20px;
  left: 20px;
  background: rgba(26, 35, 126, 0.9);
  color: white;
  padding: 12px 16px;
  border-radius: 8px;
  font-family: monospace;
  font-size: 14px;
  z-index: 1000;
  display: none;
  max-width: 400px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
`;
document.body.appendChild(selectionInfo);

// Evento quando um objeto é selecionado ao clicar
highlighter.events.select.onHighlight.add((data) => {
  console.log("✅ Selecionado:", data);
  
  // Extrai os IDs dos objetos selecionados
  const modelIds = Object.keys(data);
  if (modelIds.length > 0) {
    let infoHtml = "<strong>🎯 Objeto Selecionado</strong><br>";
    
    for (const modelId of modelIds) {
      const elementIds = data[modelId];
      const expressIds = Array.from(elementIds);
      
      infoHtml += `<br><strong>Modelo:</strong> ${modelId}<br>`;
      infoHtml += `<strong>Express IDs:</strong> ${expressIds.join(", ")}`;
    }
    
    selectionInfo.innerHTML = infoHtml;
    selectionInfo.style.display = "block";
  }
});

// Evento quando a seleção é limpa
highlighter.events.select.onClear.add(() => {
  console.log("❌ Seleção limpa");
  selectionInfo.style.display = "none";
});

// ==========================================
// ✨ Hoverer - Highlight ao passar o mouse
// ==========================================

const hoverer = components.get(OBCF.Hoverer);
hoverer.world = world;
hoverer.enabled = true;

// Configurações do efeito de hover
hoverer.duration = 150; // Duração da animação em ms
hoverer.animation = true; // Ativa animação de fade

// Customiza o material de hover (cor e opacidade)
hoverer.material = new THREE.MeshBasicMaterial({
  color: 0xbcf124, // Verde limão para hover
  transparent: true,
  opacity: 0.5,
  depthTest: false,
});

// Eventos de hover
hoverer.onHoverStarted.add(() => {
  container.style.cursor = "pointer";
});

hoverer.onHoverEnded.add(() => {
  container.style.cursor = "default";
});

// ==========================================
// 🖱️ Drag and Drop
// ==========================================

let dropZone: HTMLDivElement | null = null;

container.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.stopPropagation();
  
  if (!dropZone) {
    dropZone = document.createElement("div");
    dropZone.className = "drop-zone-active";
    dropZone.innerHTML = '<span class="drop-zone-text">Solte o arquivo IFC aqui</span>';
    document.body.append(dropZone);
  }
});

container.addEventListener("dragleave", (e) => {
  e.preventDefault();
  e.stopPropagation();
  
  if (dropZone && !container.contains(e.relatedTarget as Node)) {
    dropZone.remove();
    dropZone = null;
  }
});

container.addEventListener("drop", async (e) => {
  e.preventDefault();
  e.stopPropagation();
  
  if (dropZone) {
    dropZone.remove();
    dropZone = null;
  }
  
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    const file = files[0];
    if (file.name.toLowerCase().endsWith(".ifc")) {
      await loadIfcFromFile(file);
    } else {
      alert("Por favor, solte apenas arquivos .ifc");
    }
  }
});

// ==========================================
// 🎉 Pronto!
// ==========================================

console.log("🏗️ Visualizador IFC iniciado com sucesso!");
console.log("📋 Use o painel à direita para carregar modelos IFC.");
