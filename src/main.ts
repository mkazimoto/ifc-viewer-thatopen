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

// Posição inicial da câmera (será ajustada quando o modelo for carregado)
await world.camera.controls.setLookAt(10, 10, 10, 0, 0, 0);

components.init();

// Adiciona grid ao mundo
const grids = components.get(OBC.Grids);
const grid = grids.create(world);
grid.material.uniforms.uColor.value = new THREE.Color(0x444466);


// ==========================================
// 📦 Configuração do FragmentsManager
// ==========================================

const fragments = components.get(OBC.FragmentsManager);

// Tipagem do modelo de fragmentos
type FragmentsModelType = ReturnType<typeof fragments.list.values> extends IterableIterator<infer T> ? T : never;

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
  
  // Aguarda alguns frames para garantir que a geometria foi processada
  await new Promise(resolve => {
    let frameCount = 0;
    const waitFrames = () => {
      frameCount++;
      if (frameCount < 3) {
        requestAnimationFrame(waitFrames);
      } else {
        resolve(void 0);
      }
    };
    requestAnimationFrame(waitFrames);
  });
  
  // Ajusta o modelo ao nível 0 (remove offset de coordenadas)
  await adjustModelToLevel0(model);
  
  // Força atualização da matriz do objeto após ajuste de posição
  model.object.updateMatrixWorld(true);
  
  // Enquadra automaticamente o modelo na câmera
  frameModel(model);
  
  // Atualiza a lista de modelos na interface
  updateModelsList();
  
  // Gera automaticamente as plantas de andares e processa filtros
  setTimeout(async () => {
    await generateFloorPlans();
    await processClassifications();
    await hideIfcSpaces();
    await updateStoreyData(); // Atualiza dados para o seletor de nível da grade
  }, 500); // Pequeno delay para garantir que o modelo foi processado
});

// Função para ajustar o modelo ao nível 0 padrão
async function adjustModelToLevel0(model: FragmentsModelType): Promise<void> {
  try {
    // Obtém as coordenadas de origem do modelo IFC
    const [, coordHeight] = await model.getCoordinates();
    
    // Obtém os andares do modelo
    const storeys = await model.getItemsOfCategories([/BUILDINGSTOREY/]);
    const localIds = Object.values(storeys).flat();
    
    if (localIds.length === 0) {
      console.log("📍 Nenhum andar encontrado, modelo mantido na posição original");
      return;
    }
    
    const data = await model.getItemsData(localIds);
    
    // Encontra o andar com menor elevação (térreo/nível 0)
    let minElevation = Infinity;
    let groundFloorName = "";
    
    for (const attributes of data) {
      if ("Elevation" in attributes && 
          attributes.Elevation && 
          typeof attributes.Elevation === "object" && 
          "value" in attributes.Elevation) {
        const elevation = (attributes.Elevation as { value: number }).value;
        if (elevation < minElevation) {
          minElevation = elevation;
          if ("Name" in attributes && 
              attributes.Name && 
              typeof attributes.Name === "object" && 
              "value" in attributes.Name) {
            groundFloorName = (attributes.Name as { value: string }).value;
          }
        }
      }
    }
    
    if (minElevation !== Infinity) {
      // Calcula o offset total (coordenadas + elevação do térreo)
      const totalOffset = coordHeight + minElevation;
      
      // Move o modelo para que o térreo fique em Y=0
      model.object.position.y = -totalOffset;
      
      // Armazena o offset de elevação base para uso no seletor de nível da grade
      baseElevationOffset = minElevation;
      
      console.log(`📍 Modelo ajustado ao nível 0:`);
      console.log(`   Andar base: "${groundFloorName}" (elevação: ${minElevation.toFixed(2)}m)`);
      console.log(`   Offset de coordenadas: ${coordHeight.toFixed(2)}m`);
      console.log(`   Ajuste aplicado: Y = ${(-totalOffset).toFixed(2)}m`);
    }
  } catch (error) {
    console.warn("Não foi possível ajustar o modelo ao nível 0:", error);
  }
}

// Quando um modelo é removido, atualiza a lista
fragments.list.onItemDeleted.add(() => {
  updateModelsList();
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
    path: "./",
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
  
  // Limpa o estado de visibilidade dos modelos
  modelVisibilityState.clear();
  
  // Atualiza a lista de modelos na interface
  updateModelsList();
  
  // Reinicializa o fragments se necessário
  if (!fragments.core) {
    fragments.init(workerObjectUrl);
  }
  
  console.log("Modelos removidos.");
}

// Função para tirar screenshot/foto da cena 3D
function takeScreenshot(): void {
  try {
    // Força um render antes de capturar
    world.renderer?.update();
    
    // Obtém o canvas do renderer
    const canvas = world.renderer?.three.domElement;
    if (!canvas) {
      alert("Não foi possível capturar a tela: renderer não encontrado.");
      return;
    }
    
    // Converte o canvas para data URL (imagem PNG)
    const dataURL = canvas.toDataURL("image/png", 1.0);
    
    // Cria um link para download
    const link = document.createElement("a");
    link.href = dataURL;
    
    // Gera nome do arquivo com timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    link.download = `screenshot-${timestamp}.png`;
    
    // Dispara o download
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log("📸 Screenshot salvo:", link.download);
  } catch (error) {
    console.error("Erro ao capturar screenshot:", error);
    alert("Erro ao tirar foto. Verifique o console para mais detalhes.");
  }
}

// ==========================================
// 📋 Funções de gerenciamento de modelos
// ==========================================

// Variável para manter o estado de visibilidade de cada modelo
const modelVisibilityState = new Map<string, boolean>();

function updateModelsList(): void {
  const modelsList = document.getElementById("models-list");
  if (!modelsList) return;
  
  const modelEntries = Array.from(fragments.list.entries());
  
  if (modelEntries.length === 0) {
    modelsList.innerHTML = '<span class="filter-empty">Nenhum modelo carregado</span>';
    return;
  }
  
  modelsList.innerHTML = '';
  
  modelEntries.forEach(([modelId, _model], index) => {
    const isVisible = modelVisibilityState.get(modelId) !== false; // Por padrão é visível
    const displayName = modelId || `Modelo ${index + 1}`;
    
    const modelItem = document.createElement("div");
    modelItem.className = "filter-item";
    modelItem.innerHTML = `
      <label class="filter-label">
        <input 
          type="checkbox" 
          id="model-chk-${index}" 
          ${isVisible ? 'checked' : ''}>
        <span class="filter-text">${displayName}</span>
      </label>
    `;
    
    const checkbox = modelItem.querySelector('input') as HTMLInputElement;
    checkbox.addEventListener('change', () => {
      toggleModelVisibility(modelId, checkbox.checked);
    });
    
    modelsList.appendChild(modelItem);
  });
}

function toggleModelVisibility(modelId: string, visible: boolean): void {
  const model = fragments.list.get(modelId);
  
  if (model) {
    model.object.visible = visible;
    modelVisibilityState.set(modelId, visible);
    console.log(`Modelo ${modelId} ${visible ? 'mostrado' : 'ocultado'}`);
  }
}

function showAllModels(): void {
  const modelEntries = Array.from(fragments.list.entries());
  modelEntries.forEach(([modelId, model], index) => {
    model.object.visible = true;
    modelVisibilityState.set(modelId, true);
    
    // Atualiza checkbox
    const checkbox = document.getElementById(`model-chk-${index}`) as HTMLInputElement;
    if (checkbox) checkbox.checked = true;
  });
  console.log("Todos os modelos mostrados");
}

function hideAllModels(): void {
  const modelEntries = Array.from(fragments.list.entries());
  modelEntries.forEach(([modelId, model], index) => {
    model.object.visible = false;
    modelVisibilityState.set(modelId, false);
    
    // Atualiza checkbox
    const checkbox = document.getElementById(`model-chk-${index}`) as HTMLInputElement;
    if (checkbox) checkbox.checked = false;
  });
  console.log("Todos os modelos ocultados");
}

function frameModel(model: FragmentsModelType): void {
  try {
    const box = new THREE.Box3().setFromObject(model.object);
    
    // Verifica se o modelo tem dimensões válidas
    if (box.isEmpty()) {
      console.warn("Modelo sem dimensões válidas para enquadramento");
      return;
    }
    
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    
    // Verifica se as dimensões são muito pequenas ou muito grandes
    if (size.length() < 0.1 || size.length() > 10000) {
      console.warn("Dimensões do modelo fora do intervalo esperado:", size.length());
      // Usa fitToSphere como fallback
      world.camera.controls.fitToSphere(model.object, true);
      return;
    }
    
    const maxDim = Math.max(size.x, size.y, size.z);
    
    // Calcula uma distância adequada baseada no tamanho do modelo
    const distance = maxDim * 1.8;
    
    // Posiciona a câmera em um ângulo isométrico otimizado
    const offset = new THREE.Vector3(
      distance * 0.6,  // X: posição diagonal
      distance * 0.4,  // Y: altura
      distance * 0.8   // Z: profundidade
    );
    
    const cameraPosition = center.clone().add(offset);
    
    // Move a câmera suavemente para a nova posição
    world.camera.controls.setLookAt(
      cameraPosition.x, 
      cameraPosition.y, 
      cameraPosition.z,
      center.x,
      center.y, 
      center.z,
      true // animação suave
    );
    
    console.log(`Modelo enquadrado - Centro: ${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)} | Tamanho: ${size.x.toFixed(2)}x${size.y.toFixed(2)}x${size.z.toFixed(2)}`);
    
  } catch (error) {
    console.error("Erro ao enquadrar modelo:", error);
    // Fallback para método padrão
    world.camera.controls.fitToSphere(model.object, true);
  }
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

// Dados dos andares para o seletor de nível da grade
let storeyData: Record<string, unknown>[] = [];

// Armazena o offset de elevação base aplicado (para ajustar ao nível 0)
let baseElevationOffset = 0;

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

// Função para obter a elevação de um andar pelo nome (considerando o ajuste ao nível 0)
function getStoreyElevation(name: string): number {
  const storey = storeyData.find((attributes) => {
    if (!("Name" in attributes && attributes.Name && typeof attributes.Name === "object" && "value" in attributes.Name)) return false;
    return (attributes.Name as { value: string }).value === name;
  });
  
  if (!storey) return 0;
  if (!("Elevation" in storey && storey.Elevation && typeof storey.Elevation === "object" && "value" in storey.Elevation)) return 0;
  
  const storeyElevation = (storey.Elevation as { value: number }).value;
  
  // Retorna a elevação relativa ao nível 0 (subtraindo o offset de elevação base)
  return storeyElevation - baseElevationOffset;
}

// Função para atualizar os dados dos andares (para o seletor de nível da grade)
async function updateStoreyData(): Promise<void> {
  const models = Array.from(fragments.list.values());
  
  if (models.length === 0) {
    storeyData = [];
    updateGridLevelDropdown();
    return;
  }

  try {
    // Combina os andares de todos os modelos carregados
    const allStoreyData: Record<string, unknown>[] = [];
    const seenNames = new Set<string>();
    
    for (const model of models) {
      const storeys = await model.getItemsOfCategories([/BUILDINGSTOREY/]);
      const localIds = Object.values(storeys).flat();
      const data = await model.getItemsData(localIds);
      
      // Adiciona andares únicos (evita duplicatas por nome)
      for (const attributes of data) {
        if ("Name" in attributes && 
            attributes.Name && 
            typeof attributes.Name === "object" && 
            "value" in attributes.Name) {
          const name = (attributes.Name as { value: string }).value;
          if (!seenNames.has(name)) {
            seenNames.add(name);
            allStoreyData.push(attributes);
          }
        }
      }
    }
    
    // Ordena por elevação (do menor para o maior)
    allStoreyData.sort((a, b) => {
      const elevA = ("Elevation" in a && a.Elevation && typeof a.Elevation === "object" && "value" in a.Elevation)
        ? (a.Elevation as { value: number }).value : 0;
      const elevB = ("Elevation" in b && b.Elevation && typeof b.Elevation === "object" && "value" in b.Elevation)
        ? (b.Elevation as { value: number }).value : 0;
      return elevA - elevB;
    });
    
    storeyData = allStoreyData;
    console.log("📊 Dados dos andares carregados:", storeyData.length, "andares de", models.length, "modelo(s)");
    updateGridLevelDropdown();
  } catch (error) {
    console.warn("Erro ao obter dados dos andares:", error);
    storeyData = [];
    updateGridLevelDropdown();
  }
}

// Função para atualizar o dropdown de nível da grade
function updateGridLevelDropdown(): void {
  const dropdown = document.querySelector("#grid-level-dropdown") as HTMLSelectElement;
  if (!dropdown) return;

  dropdown.innerHTML = '<option value="">-- Nível Padrão (0) --</option>';
  
  for (const attributes of storeyData) {
    if ("Name" in attributes && attributes.Name && typeof attributes.Name === "object" && "value" in attributes.Name) {
      const name = (attributes.Name as { value: string }).value;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      dropdown.appendChild(option);
    }
  }
}

// Função para alterar o nível da grade
function onGridLevelChange(e: Event): void {
  const target = e.target as HTMLSelectElement;
  const level = target.value;
  
  if (!level) {
    grid.three.position.y = 0;
    console.log("📍 Grade movida para nível padrão (Y = 0)");
    return;
  }
  
  const elevation = getStoreyElevation(level);
  grid.three.position.y = elevation;
  console.log(`📍 Grade movida para nível "${level}" (Y = ${elevation.toFixed(2)}m)`);
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
  if (currentViewId && views.list.has(currentViewId)) {
    try {
      views.close(currentViewId);
    } catch (error) {
      console.warn("Erro ao fechar vista anterior:", error);
    }
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
    const size = box.getSize(new THREE.Vector3());
    
    // Calcula a distância necessária para enquadrar o modelo (vista de cima)
    const maxDim = Math.max(size.x, size.z);
    const distance = maxDim * 1.2; // Margem de 20%
    
    // Posiciona a câmera de cima olhando para baixo
    await world.camera.controls.setLookAt(
      center.x, center.y + distance, center.z,  // Posição da câmera (de cima)
      center.x, center.y, center.z,              // Alvo (centro do modelo)
      true
    );
    
    // Ajusta o zoom para enquadrar o modelo
    await world.camera.controls.fitToBox(box, true, {
      paddingTop: 20,
      paddingBottom: 20,
      paddingLeft: 20,
      paddingRight: 20
    });
    
    // Desabilita rotação na vista de planta (apenas pan e zoom)
    world.camera.controls.minPolarAngle = 0;
    world.camera.controls.maxPolarAngle = 0;
  }
}

// Função para fechar a vista de planta
async function closePlantView(): Promise<void> {
  if (!currentViewId) return;

  if (views.list.has(currentViewId)) {
    try {
      views.close(currentViewId);
    } catch (error) {
      console.warn("Erro ao fechar vista de planta:", error);
    }
  }
  currentViewId = null;

  // Mostra o grid novamente
  grid.visible = true;

  // Reseta a câmera para 3D
  world.camera.projection.set("Perspective");
  
  // Restaura a rotação livre da câmera
  world.camera.controls.minPolarAngle = 0;
  world.camera.controls.maxPolarAngle = Math.PI;
  
  // Enquadra o modelo se existir
  const models = Array.from(fragments.list.values());
  if (models.length > 0) {
    frameModel(models[0]);
  } else {
    world.camera.controls.setLookAt(50, 30, 50, 0, 0, 0, true);
  }

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

// Oculta automaticamente elementos IfcSpace
async function hideIfcSpaces(): Promise<void> {
  const [model] = fragments.list.values();
  if (!model) return;

  const categories = classifier.list.get("Categories");
  if (!categories) return;

  // Procura por IfcSpace nas categorias
  for (const [categoryName, groupData] of categories) {
    if (categoryName.toLowerCase().includes("ifcspace")) {
      console.log("🚫 Ocultando elementos IfcSpace...");
      
      const itemsMap = await groupData.get();
      for (const expressIds of Object.values(itemsMap)) {
        const ids = Array.isArray(expressIds) ? expressIds : Array.from(expressIds as Set<number>);
        model.setVisible(ids, false);
      }
      
      // Atualiza o estado do filtro para refletir que está desmarcado
      filterState.categories.set(categoryName, false);
    }
  }

  // Atualiza a UI e renderização
  updateFilterUI();
  fragments.core.update(true);
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

// Double-click para criar plano de corte OU enquadrar objeto selecionado
container.addEventListener("dblclick", async () => {
  if (clippingMode) {
    // No modo de plano de corte, cria um novo plano
    await clipper.create(world);
  } else {
    // Fora do modo de corte, tenta enquadrar o objeto sob o cursor
    await frameObjectUnderCursor();
  }
});

// Função para enquadrar o objeto sob o cursor ao dar duplo clique
async function frameObjectUnderCursor(): Promise<void> {
  try {
    const casters = components.get(OBC.Raycasters);
    const caster = casters.get(world);
    const result = await caster.castRay() as unknown as {
      fragments: { modelId: string; localIds: Set<number> };
      object: THREE.Mesh;
      point: THREE.Vector3;
    } | null;

    if (!result || !result.fragments) {
      console.log("❌ Nenhum objeto sob o cursor para enquadrar");
      return;
    }

    const { modelId } = result.fragments;
    const model = fragments.list.get(modelId);
    
    if (!model || !model.object.visible) {
      console.log("❌ Modelo não encontrado ou invisível");
      return;
    }

    // Calcula a bounding box do objeto intersectado
    const bbox = new THREE.Box3();
    
    if (result.object && result.object.geometry) {
      // Usa a geometria do objeto intersectado
      result.object.geometry.computeBoundingBox();
      const geomBox = result.object.geometry.boundingBox;
      if (geomBox) {
        bbox.copy(geomBox).applyMatrix4(result.object.matrixWorld);
      }
    }

    if (bbox.isEmpty()) {
      // Fallback: usa o ponto de interseção como centro com tamanho padrão
      if (result.point) {
        const defaultSize = 2;
        bbox.setFromCenterAndSize(
          result.point,
          new THREE.Vector3(defaultSize, defaultSize, defaultSize)
        );
      } else {
        console.log("❌ Não foi possível calcular o bounding box do objeto");
        return;
      }
    }

    // Calcula centro e tamanho do objeto
    const center = bbox.getCenter(new THREE.Vector3());
    const size = bbox.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    
    // Distância da câmera baseada no tamanho do objeto
    const distance = Math.max(maxDim * 2.5, 3); // Mínimo de 3 unidades
    
    // Mantém a direção atual da câmera, mas aproxima do objeto
    const currentPosition = new THREE.Vector3();
    world.camera.three.getWorldPosition(currentPosition);
    
    const direction = currentPosition.clone().sub(center).normalize();
    const newPosition = center.clone().add(direction.multiplyScalar(distance));
    
    // Move a câmera suavemente para enquadrar o objeto
    await world.camera.controls.setLookAt(
      newPosition.x,
      newPosition.y,
      newPosition.z,
      center.x,
      center.y,
      center.z,
      true // animação suave
    );

    console.log(`🎯 Objeto enquadrado - Centro: (${center.x.toFixed(2)}, ${center.y.toFixed(2)}, ${center.z.toFixed(2)}) | Tamanho: ${maxDim.toFixed(2)}m`);
    
  } catch (error) {
    console.error("Erro ao enquadrar objeto:", error);
  }
}

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
    <bim-panel-section label="📋 Modelos" collapsed>
      <bim-label>Selecione um arquivo IFC:</bim-label>
      
      <input 
        id="file-input"
        type="file" 
        accept=".ifc" 
        style="margin-top: 8px; color: white;"
      />

       <div style="display: flex; gap: 8px; margin-bottom: 8px;">
        <bim-button id="show-all-models" label="Mostrar Todos" icon="mdi:eye" style="flex:1"></bim-button>
        <bim-button id="hide-all-models" label="Ocultar Todos" icon="mdi:eye-off" style="flex:1"></bim-button>
      </div>
      <div id="models-list" class="filter-container">
        <span class="filter-empty">Nenhum modelo carregado</span>
      </div>

      <bim-button 
        id="clear-btn"
        label="Limpar Modelos" 
        icon="mdi:delete">
      </bim-button>
    </bim-panel-section>

    <bim-panel-section label="📷 Câmera" collapsed>
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
        id="frame-model-btn"
        label="Enquadrar Modelo" 
        icon="mdi:fit-to-page-outline">
      </bim-button>
      
      <bim-button 
        id="screenshot-btn"
        label="Tirar Foto" 
        icon="mdi:camera">
      </bim-button>
    </bim-panel-section>

    <bim-panel-section label="🏢 Plantas de Andares" collapsed>
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

    <bim-panel-section label="� Nível da Grade" collapsed>
      <bim-label>Mover grade para um nível:</bim-label>
      
      <select 
        id="grid-level-dropdown"
        style="width: 100%; padding: 8px; margin-top: 4px; border-radius: 4px; background: #2a2a4a; color: white; border: 1px solid #444;">
        <option value="">-- Nível Padrão (0) --</option>
      </select>
      
      <bim-checkbox 
        id="grid-visible-checkbox"
        label="Grade visível" 
        checked
        style="margin-top: 8px">
      </bim-checkbox>
      
      <bim-color-input 
        id="grid-color-input"
        label="Cor da grade" 
        color="#444466"
        style="margin-top: 8px">
      </bim-color-input>
    </bim-panel-section>

    <bim-panel-section label="�🔍 Filtro por Andar" collapsed>
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

    <bim-panel-section label="✂️ Planos de Corte" collapsed>
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

    <bim-panel-section label="🔧 Ações" collapsed>
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

  `;

  // Adiciona event listeners
  panel.querySelector("#file-input")?.addEventListener("change", onFileInput);
  panel.querySelector("#perspective-btn")?.addEventListener("click", () => world.camera.projection.set("Perspective"));
  panel.querySelector("#orthographic-btn")?.addEventListener("click", () => world.camera.projection.set("Orthographic"));
  panel.querySelector("#reset-camera-btn")?.addEventListener("click", () => {
    // Se há um modelo carregado, enquadra ele automaticamente
    const models = Array.from(fragments.list.values());
    if (models.length > 0) {
      frameModel(models[0]); // Usa o primeiro modelo
    } else {
      // Se não há modelo, volta para a posição padrão
      world.camera.controls.setLookAt(10, 10, 10, 0, 0, 0, true);
    }
  });
  panel.querySelector("#download-btn")?.addEventListener("click", downloadFragments);
  panel.querySelector("#clear-btn")?.addEventListener("click", clearModels);
  
  // Event listeners para gerenciamento de modelos
  panel.querySelector("#frame-model-btn")?.addEventListener("click", () => {
    const models = Array.from(fragments.list.values());
    if (models.length > 0) {
      frameModel(models[0]);
    } else {
      alert("Nenhum modelo carregado para enquadrar.");
    }
  });
  
  // Event listener para tirar foto/screenshot
  panel.querySelector("#screenshot-btn")?.addEventListener("click", () => {
    takeScreenshot();
  });
  
  panel.querySelector("#show-all-models")?.addEventListener("click", () => showAllModels());
  panel.querySelector("#hide-all-models")?.addEventListener("click", () => hideAllModels());

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

  // Event listeners para o seletor de nível da grade
  panel.querySelector("#grid-level-dropdown")?.addEventListener("change", onGridLevelChange);
  
  const gridVisibleCheckbox = panel.querySelector("#grid-visible-checkbox") as BUI.Checkbox;
  gridVisibleCheckbox?.addEventListener("change", () => {
    grid.config.visible = gridVisibleCheckbox.checked;
  });
  
  const gridColorInput = panel.querySelector("#grid-color-input") as BUI.ColorInput;
  gridColorInput?.addEventListener("input", () => {
    grid.config.color = new THREE.Color(gridColorInput.color);
  });

  return panel;
}

const panel = createPanel();
document.body.append(panel);

// Comportamento de accordion - apenas uma seção aberta por vez
const panelSections = panel.querySelectorAll("bim-panel-section");
panelSections.forEach((section) => {
  section.addEventListener("click", (e) => {
    const target = e.currentTarget as BUI.PanelSection;
    
    // Se a seção clicada está sendo aberta (não tem o atributo collapsed)
    if (!target.hasAttribute("collapsed")) {
      // Fecha todas as outras seções
      panelSections.forEach((otherSection) => {
        if (otherSection !== target && !otherSection.hasAttribute("collapsed")) {
          otherSection.setAttribute("collapsed", "");
        }
      });
    }
  });
});

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
// 🎲 ViewCube - Cubo de Visualização
// ==========================================

function createViewCube() {
  // Container do ViewCube
  const viewCubeContainer = document.createElement("div");
  viewCubeContainer.id = "viewcube-container";
  viewCubeContainer.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 340px;
    width: 120px;
    height: 120px;
    z-index: 999;
    pointer-events: auto;
  `;
  document.body.appendChild(viewCubeContainer);

  // Cria cena separada para o ViewCube
  const cubeScene = new THREE.Scene();
  const cubeCamera = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 100);
  cubeCamera.position.set(3, 3, 3);
  cubeCamera.lookAt(0, 0, 0);

  // Renderer separado para o ViewCube
  const cubeRenderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  cubeRenderer.setSize(120, 120);
  cubeRenderer.setPixelRatio(window.devicePixelRatio);
  cubeRenderer.setClearColor(0x000000, 0);
  viewCubeContainer.appendChild(cubeRenderer.domElement);
  cubeRenderer.domElement.style.cursor = "pointer";

  // Materiais para cada face do cubo
  const faceColors = {
    front: 0x4a90d9,    // Azul
    back: 0x4a90d9,
    top: 0x7cb342,      // Verde
    bottom: 0x7cb342,
    right: 0xe57373,    // Vermelho
    left: 0xe57373
  };

  // Cria texturas com labels para cada face
  function createFaceTexture(text: string, bgColor: number): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext("2d")!;
    
    // Background
    ctx.fillStyle = `#${bgColor.toString(16).padStart(6, "0")}`;
    ctx.fillRect(0, 0, 128, 128);
    
    // Borda
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 124, 124);
    
    // Texto
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px Arial";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 64, 64);
    
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    return texture;
  }

  // Cria os materiais com texturas
  const materials = [
    new THREE.MeshBasicMaterial({ map: createFaceTexture("DIR", faceColors.right) }),   // +X (Direita)
    new THREE.MeshBasicMaterial({ map: createFaceTexture("ESQ", faceColors.left) }),    // -X (Esquerda)
    new THREE.MeshBasicMaterial({ map: createFaceTexture("TOPO", faceColors.top) }),    // +Y (Topo)
    new THREE.MeshBasicMaterial({ map: createFaceTexture("BASE", faceColors.bottom) }), // -Y (Base)
    new THREE.MeshBasicMaterial({ map: createFaceTexture("FRENTE", faceColors.front) }),// +Z (Frente)
    new THREE.MeshBasicMaterial({ map: createFaceTexture("TRÁS", faceColors.back) })    // -Z (Trás)
  ];

  // Geometria do cubo
  const geometry = new THREE.BoxGeometry(1.5, 1.5, 1.5);
  const cube = new THREE.Mesh(geometry, materials);
  cubeScene.add(cube);

  // Adiciona eixos de referência
  const axesHelper = new THREE.AxesHelper(1.2);
  cubeScene.add(axesHelper);

  // Raycaster para detectar cliques
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();

  // Função para obter a distância atual da câmera ao target
  function getCameraDistance(): number {
    const position = new THREE.Vector3();
    const target = new THREE.Vector3();
    world.camera.controls.getPosition(position);
    world.camera.controls.getTarget(target);
    return position.distanceTo(target);
  }

  // Função para mover a câmera principal para uma vista específica
  function setCameraView(direction: THREE.Vector3) {
    const target = new THREE.Vector3();
    world.camera.controls.getTarget(target);
    
    const distance = getCameraDistance();
    const newPosition = target.clone().add(direction.multiplyScalar(distance));
    
    world.camera.controls.setLookAt(
      newPosition.x, newPosition.y, newPosition.z,
      target.x, target.y, target.z,
      true
    );
  }

  // Vistas predefinidas
  const views: { [key: string]: THREE.Vector3 } = {
    front: new THREE.Vector3(0, 0, 1),
    back: new THREE.Vector3(0, 0, -1),
    top: new THREE.Vector3(0, 1, 0.001), // Pequeno offset para evitar problemas de up vector
    bottom: new THREE.Vector3(0, -1, 0.001),
    right: new THREE.Vector3(1, 0, 0),
    left: new THREE.Vector3(-1, 0, 0),
    iso: new THREE.Vector3(1, 1, 1).normalize()
  };

  // Handler de clique no cubo
  cubeRenderer.domElement.addEventListener("click", (event) => {
    const rect = cubeRenderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, cubeCamera);
    const intersects = raycaster.intersectObject(cube);

    if (intersects.length > 0) {
      const faceIndex = intersects[0].face!.materialIndex;
      
      switch (faceIndex) {
        case 0: setCameraView(views.right.clone()); break;  // Direita
        case 1: setCameraView(views.left.clone()); break;   // Esquerda
        case 2: setCameraView(views.top.clone()); break;    // Topo
        case 3: setCameraView(views.bottom.clone()); break; // Base
        case 4: setCameraView(views.front.clone()); break;  // Frente
        case 5: setCameraView(views.back.clone()); break;   // Trás
      }
    }
  });

  // Duplo clique para vista isométrica
  cubeRenderer.domElement.addEventListener("dblclick", () => {
    setCameraView(views.iso.clone());
  });

  // Atualiza a rotação do ViewCube para sincronizar com a câmera principal
  function updateViewCube() {
    const cameraPosition = new THREE.Vector3();
    const target = new THREE.Vector3();
    world.camera.controls.getPosition(cameraPosition);
    world.camera.controls.getTarget(target);

    // Calcula a direção da câmera
    const direction = cameraPosition.clone().sub(target).normalize();
    
    // Posiciona a câmera do ViewCube na mesma direção relativa
    cubeCamera.position.copy(direction.multiplyScalar(5));
    cubeCamera.lookAt(0, 0, 0);
    
    cubeRenderer.render(cubeScene, cubeCamera);
  }

  // Atualiza o ViewCube a cada frame
  world.renderer?.onAfterUpdate.add(() => updateViewCube());

  // Render inicial
  updateViewCube();
  
  console.log("🎲 ViewCube criado com sucesso");
}

// Inicializa o ViewCube
createViewCube();

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
  width: 350px;
  background: rgba(26, 35, 126, 0.95);
  color: white;
  padding: 16px 20px;
  border-radius: 8px;
  font-family: 'Segoe UI', Arial, sans-serif;
  font-size: 13px;
  z-index: 1000;
  display: none;
  max-height: 60vh;
  overflow-y: auto;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
`;
document.body.appendChild(selectionInfo);

// Função para formatar valor de propriedade
function formatPropertyValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const innerValue = (value as Record<string, unknown>).value;
    if (typeof innerValue === "number") {
      return innerValue.toFixed(2).replace(/\.00$/, "");
    }
    return String(innerValue);
  }
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (typeof value === "number") return value.toFixed(2).replace(/\.00$/, "");
  return String(value);
}

// Função para buscar e exibir propriedades do elemento
async function displayElementProperties(modelId: string, expressIds: number[]): Promise<string> {
  const model = fragments.list.get(modelId);
  if (!model) return "";

  try {
    // Busca os dados do elemento com suas relações (PropertySets)
    const itemsData = await model.getItemsData(expressIds, {
      relations: {
        IsDefinedBy: { attributes: true, relations: true },
        IsTypedBy: { attributes: true, relations: false },
        HasPropertySets: { attributes: true, relations: true },
      },
    });

    let html = "";

    for (const item of itemsData) {
      // Informações básicas do elemento
      const category = item._category && "value" in item._category ? item._category.value : "Desconhecido";
      const name = item.Name && "value" in item.Name ? item.Name.value : "Sem nome";
      const globalId = item.GlobalId && "value" in item.GlobalId ? item.GlobalId.value : "";

      html += `<div style="margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.2);">`;
      html += `<div style="font-size: 16px; font-weight: bold; color: #bcf124; margin-bottom: 4px;">${name}</div>`;
      html += `<div style="font-size: 11px; color: #aaa;">${category}</div>`;
      if (globalId) html += `<div style="font-size: 10px; color: #888; font-family: monospace;">${globalId}</div>`;
      html += `</div>`;

      // PropertySets
      const propertySets: Record<string, unknown>[] = [];

      // Coleta PropertySets de IsDefinedBy
      if (Array.isArray(item.IsDefinedBy)) {
        for (const definition of item.IsDefinedBy) {
          if (definition && "value" in definition._category) {
            const defCategory = definition._category.value;
            if (defCategory === "IFCPROPERTYSET" || defCategory === "IFCELEMENTQUANTITY") {
              propertySets.push(definition);
            }
          }
        }
      }

      // Coleta PropertySets do Type
      if (Array.isArray(item.IsTypedBy)) {
        for (const type of item.IsTypedBy) {
          if (type && Array.isArray(type.HasPropertySets)) {
            for (const pset of type.HasPropertySets) {
              if (pset && "value" in pset._category) {
                propertySets.push(pset);
              }
            }
          }
        }
      }

      // Exibe cada PropertySet
      for (const pset of propertySets) {
        const psetName = pset.Name && "value" in (pset.Name as Record<string, unknown>) 
          ? (pset.Name as Record<string, unknown>).value 
          : "PropertySet";
        
        html += `<div style="margin-bottom: 10px;">`;
        html += `<div style="font-weight: bold; color: #81d4fa; font-size: 12px; margin-bottom: 6px; cursor: pointer;" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">📁 ${psetName}</div>`;
        html += `<div style="padding-left: 12px; font-size: 11px;">`;

        // Propriedades
        const propsKey = Array.isArray(pset.HasProperties) ? "HasProperties" : 
                         Array.isArray(pset.Quantities) ? "Quantities" : null;
        
        if (propsKey && Array.isArray(pset[propsKey])) {
          for (const prop of pset[propsKey] as Record<string, unknown>[]) {
            const propName = prop.Name && "value" in (prop.Name as Record<string, unknown>) 
              ? (prop.Name as Record<string, unknown>).value 
              : "Propriedade";
            
            // Encontra o valor (pode ser NominalValue, Value, AreaValue, LengthValue, etc.)
            let propValue = "—";
            let unit = "";
            const valueKeysWithUnits: Record<string, string> = {
              "LengthValue": "m",
              "AreaValue": "m²",
              "VolumeValue": "m³",
              "WeightValue": "kg",
              "TimeValue": "s",
              "CountValue": "",
              "NominalValue": "",
              "Value": ""
            };
            
            for (const vk of Object.keys(valueKeysWithUnits)) {
              if (prop[vk]) {
                propValue = formatPropertyValue(prop[vk]);
                unit = valueKeysWithUnits[vk];
                break;
              }
            }

            // Formata o valor com unidade se aplicável
            const displayValue = unit ? `${propValue} ${unit}` : propValue;

            html += `<div style="display: flex; justify-content: space-between; padding: 2px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">`;
            html += `<span style="color: #ccc;">${propName}</span>`;
            html += `<span style="color: #fff; font-weight: 500; max-width: 200px; text-align: right; word-break: break-word;">${displayValue}</span>`;
            html += `</div>`;
          }
        }

        html += `</div></div>`;
      }

      if (propertySets.length === 0) {
        html += `<div style="color: #888; font-style: italic;">Nenhum PropertySet encontrado</div>`;
      }
    }

    return html;
  } catch (error) {
    console.error("Erro ao buscar propriedades:", error);
    return `<div style="color: #ff6b6b;">Erro ao carregar propriedades</div>`;
  }
}

// Evento quando um objeto é selecionado ao clicar
highlighter.events.select.onHighlight.add(async (data) => {
  console.log("✅ Selecionado:", data);
  
  // Filtra modelos invisíveis
  const visibleModelIds = Object.keys(data).filter(modelId => {
    const model = fragments.list.get(modelId);
    return model && model.object.visible;
  });
  
  // Se o modelo selecionado está invisível, ignora e limpa a seleção
  if (visibleModelIds.length === 0) {
    highlighter.clear("select");
    return;
  }
  
  // Mostra loading
  selectionInfo.innerHTML = `<div style="text-align: center; padding: 20px;">
    <div style="color: #bcf124;">🔄 Carregando propriedades...</div>
  </div>`;
  selectionInfo.style.display = "block";
  
  // Extrai os IDs dos objetos selecionados (apenas de modelos visíveis)
  let fullHtml = "";
  
  for (const modelId of visibleModelIds) {
    const elementIds = data[modelId];
    const expressIds = Array.from(elementIds);
    
    // Busca e exibe as propriedades
    const propertiesHtml = await displayElementProperties(modelId, expressIds);
    fullHtml += propertiesHtml;
    
    // Centraliza a rotação da câmera no objeto selecionado
    const model = fragments.list.get(modelId);
    if (model && model.object) {
      const bbox = new THREE.Box3().setFromObject(model.object);
      const center = new THREE.Vector3();
      bbox.getCenter(center);
      world.camera.controls.setTarget(center.x, center.y, center.z, true);
    }
  }
  
  // Adiciona botão de fechar
  fullHtml = `<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
    <span style="font-size: 14px; font-weight: bold;">🎯 Propriedades do Elemento</span>
    <button onclick="document.getElementById('selection-info').style.display='none'" 
      style="background: transparent; border: none; color: white; cursor: pointer; font-size: 18px; padding: 0 4px;">✕</button>
  </div>` + fullHtml;
  
  selectionInfo.innerHTML = fullHtml;
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

// Intercepta o hover para ignorar modelos invisíveis
let lastHoveredModel: string | null = null;

// Sobrescreve o método hover do hoverer para filtrar modelos invisíveis
const originalHover = hoverer.hover.bind(hoverer);
hoverer.hover = async function() {
  if (!hoverer.enabled) return;
  if (!hoverer.world) return;

  const casters = components.get(OBC.Raycasters);
  const caster = casters.get(hoverer.world);
  const result = await caster.castRay() as unknown as {
    fragments: { modelId: string };
    localId: number;
  } | null;

  if (!result) {
    lastHoveredModel = null;
    return originalHover();
  }

  // Verifica se o modelo está visível
  const modelId = result.fragments?.modelId;
  if (modelId) {
    const model = fragments.list.get(modelId);
    if (!model || !model.object.visible) {
      // Modelo invisível, não faz hover
      if (lastHoveredModel) {
        lastHoveredModel = null;
        hoverer.onHoverEnded.trigger();
      }
      return;
    }
  }

  lastHoveredModel = modelId;
  return originalHover();
};

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
