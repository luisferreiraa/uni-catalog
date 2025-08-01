// jest.config.js
const path = require("path") // Importar o módulo 'path'

const customJestConfig = {
    rootDir: __dirname, // Garante que os caminhos são resolvidos a partir da raiz do projeto
    setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
    testEnvironment: "jest-environment-jsdom",
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/src/$1'
    },
    // Garante que ts-jest transforma ficheiros .ts e .tsx
    transform: {
        "^.+\\.(ts|tsx)$": "ts-jest",
    },
    // Adicione esta linha para garantir que o Jest sabe quais extensões de ficheiro procurar
    moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
    transform: {
        '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.json', jsx: 'react-jsx' }]
    },
    testPathIgnorePatterns: ["/node_modules/", "/.next/"],
    collectCoverageFrom: [
        "app/**/*.{ts,tsx}",
        "components/**/*.{ts,tsx}",
        "lib/**/*.{ts,tsx}",
        "!app/layout.tsx",
        "!app/globals.css",
        "!lib/template-cache.ts",
        "!lib/prompt-optimizer.ts",
        "!lib/database.ts",
    ],
    reporters: ["default", ["jest-junit", { outputDirectory: "test-results", outputName: "junit.xml" }]],
}

module.exports = customJestConfig
