# IFC Viewer - ThatOpen Components

Visualizador IFC moderno e interativo construído com ThatOpen Components, Three.js e Vite.

DEMO: https://mkazimoto.github.io/ifc-viewer-thatopen/

https://github.com/thatopen

<img width="1920" height="1032" alt="screenshot1" src="https://github.com/user-attachments/assets/16ee249b-dc62-4552-b572-6645a72e077c" />

<img width="1920" height="1032" alt="screenshot2" src="https://github.com/user-attachments/assets/9c0bc211-9295-4f74-a003-c89680388e53" />

## 📋 Pré-requisitos

- Node.js (versão 16 ou superior)
- npm ou yarn

## 🚀 Instalação

Clone o repositório e instale as dependências:

```bash
npm install
```

## 💻 Executando o Projeto

### Modo Desenvolvimento

Para iniciar o servidor de desenvolvimento com hot-reload:

```bash
npm run dev
```

O aplicativo estará disponível em `http://localhost:5173` (ou outra porta indicada no terminal).

### Build para Produção

Para gerar a versão otimizada para produção:

```bash
npm run build
```

Os arquivos otimizados serão gerados na pasta `dist/`.

### Preview da Build

Para visualizar a build de produção localmente:

```bash
npm run preview
```

## 📦 Scripts Disponíveis

- **`npm run dev`** - Inicia servidor de desenvolvimento
- **`npm run build`** - Compila TypeScript e gera build de produção
- **`npm run preview`** - Visualiza a build de produção localmente

## 🏗️ Estrutura do Projeto

```
ifc-viewer-thatopen/
├── src/
│   ├── main.ts          # Código principal do aplicativo
│   └── styles.css       # Estilos CSS
├── public/              # Arquivos estáticos e bibliotecas web-ifc
├── index.html           # Página HTML principal
├── package.json         # Dependências e scripts
├── tsconfig.json        # Configuração TypeScript
└── vite.config.ts       # Configuração Vite
```

## 🔧 Tecnologias

- **ThatOpen Components** - Biblioteca para visualização BIM
- **Three.js** - Biblioteca 3D para WebGL
- **TypeScript** - Linguagem de programação
- **Vite** - Build tool e dev server

## 📄 Licença

Este projeto está sob a licença MIT - consulte o arquivo LICENSE.md para mais detalhes.
