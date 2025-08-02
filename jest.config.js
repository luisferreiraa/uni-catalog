const path = require("path");

module.exports = {
    rootDir: __dirname,
    setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
    testEnvironment: "jest-environment-jsdom",
    moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/src/$1"
    },
    transform: {
        "^.+\\.(ts|tsx|js|jsx)$": "babel-jest"
    },
    moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
    testPathIgnorePatterns: ["/node_modules/", "/.next/"],
    collectCoverageFrom: [
        "src/app/**/*.{ts,tsx}",
        "src/components/**/*.{ts,tsx}",
        "src/lib/**/*.{ts,tsx}",
        "!src/app/layout.tsx",
        "!src/app/globals.css",
        "!src/lib/template-cache.ts",
        "!src/lib/prompt-optimizer.ts",
        "!src/lib/database.ts"
    ],
    reporters: [
        "default",
        ["jest-junit", { outputDirectory: "test-results", outputName: "junit.xml" }]
    ]
};
