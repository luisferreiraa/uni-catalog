import { POST } from "@/app/api/uni-dialog/route"
import { templateCache } from "@/lib/template-cache"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import { databaseService } from "@/lib/database"
import OpenAI from "openai"
import type { CatalogResponse, Template } from "@/app/types/unimarc"

// Mock das dependências externas
jest.mock("@/lib/template-cache")
jest.mock("@/lib/prompt-optimizer")
jest.mock("@/lib/database")
jest.mock("next/server", () => ({
    NextResponse: {
        json: jest.fn((data) => ({ json: () => Promise.resolve(data), status: 200 })),
    },
}))


let mockChatCompletionsCreate = jest.fn()

jest.mock("openai", () => {
    return jest.fn(() => ({
        chat: {
            completions: {
                create: mockChatCompletionsCreate
            }
        }
    }));
});


const mockTemplateCache = templateCache as jest.Mocked<typeof templateCache>
const mockPromptOptimizer = promptOptimizer as jest.Mocked<typeof promptOptimizer>
const mockDatabaseService = databaseService as jest.Mocked<typeof databaseService>

const mockTemplate: Template = {
    id: "temp1",
    name: "Livro",
    description: "Template para livros",
    controlFields: [
        {
            id: "cf1",
            tag: "001",
            repeatable: false,
            mandatory: true,
            translations: [{ id: "t1", language: "pt", name: "Identificador" }],
            createdAt: new Date().toISOString(),
        },
        {
            id: "cf2",
            tag: "003",
            repeatable: false,
            mandatory: false,
            translations: [{ id: "t2", language: "pt", name: "Identificador de Registo Persistente" }],
            createdAt: new Date().toISOString(),
        },
    ],
    dataFields: [
        {
            id: "df1",
            tag: "200",
            repeatable: true,
            mandatory: true,
            translations: [{ id: "t3", language: "pt", name: "Título e Responsabilidade" }],
            subFieldDef: [
                {
                    id: "sf1",
                    code: "a",
                    repeatable: false,
                    mandatory: true,
                    translations: [{ id: "st1", language: "pt", label: "Título", subfieldId: "sf1" }],
                    dataFieldId: "df1",
                    createdAt: new Date().toISOString(),
                },
                {
                    id: "sf2",
                    code: "f",
                    repeatable: false,
                    mandatory: false,
                    translations: [{ id: "st2", language: "pt", label: "Primeira responsabilidade", subfieldId: "sf2" }],
                    dataFieldId: "df1",
                    createdAt: new Date().toISOString(),
                },
            ],
            createdAt: new Date().toISOString(),
        },
        {
            id: "df2",
            tag: "210",
            repeatable: true,
            mandatory: false,
            translations: [{ id: "t4", language: "pt", name: "Publicação" }],
            subFieldDef: [
                {
                    id: "sf3",
                    code: "c",
                    repeatable: false,
                    mandatory: false,
                    translations: [{ id: "st3", language: "pt", label: "Local de publicação", subfieldId: "sf3" }],
                    dataFieldId: "df2",
                    createdAt: new Date().toISOString(),
                },
                {
                    id: "sf4",
                    code: "d",
                    repeatable: false,
                    mandatory: false,
                    translations: [{ id: "st4", language: "pt", label: "Data de publicação", subfieldId: "sf4" }],
                    dataFieldId: "df2",
                    createdAt: new Date().toISOString(),
                },
            ],
            createdAt: new Date().toISOString(),
        },
        {
            id: "df3",
            tag: "101",
            repeatable: false,
            mandatory: true,
            translations: [{ id: "t5", language: "pt", name: "Língua" }],
            subFieldDef: [
                {
                    id: "sf5",
                    code: "a",
                    repeatable: false,
                    mandatory: true,
                    translations: [{ id: "st5", language: "pt", label: "Língua da obra", subfieldId: "sf5" }],
                    dataFieldId: "df3",
                    createdAt: new Date().toISOString(),
                },
                {
                    id: "sf6",
                    code: "b",
                    repeatable: false,
                    mandatory: false,
                    translations: [{ id: "st6", language: "pt", label: "Língua do resumo", subfieldId: "sf6" }],
                    dataFieldId: "df3",
                    createdAt: new Date().toISOString(),
                },
            ],
            createdAt: new Date().toISOString(),
        },
    ],
    createdAt: new Date().toISOString(),
}

describe("Catalog API Route (POST)", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        // Configurações padrão para os mocks
        mockTemplateCache.getTemplates.mockResolvedValue({ templates: [mockTemplate] })
        mockPromptOptimizer.buildPrompt.mockReturnValue({
            prompt: "mock prompt",
            systemMessage: "mock system message",
            maxTokens: 100,
            temperature: 0.5,
            model: "gpt-4o",
        })
        mockChatCompletionsCreate.mockResolvedValue({
            choices: [{ message: { content: "mock response" } }],
            id: "chatcmpl-123",
            created: 123,
            model: "gpt-4o",
            object: "chat.completion",
        } as any)
        mockDatabaseService.saveRecord.mockResolvedValue("record123")
    })

    it("should select a template and transition to bulk-auto-fill", async () => {
        mockChatCompletionsCreate.mockResolvedValueOnce({
            choices: [{ message: { content: "Livro" } }],
            id: "chatcmpl-123",
            created: 123,
            model: "gpt-4o",
            object: "chat.completion",
        } as any)

        const req = {
            json: () => Promise.resolve({ description: "um livro" }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("template-selected")
        expect(data.conversationState?.step).toBe("bulk-auto-fill")
        expect(data.template?.name).toBe("Livro")
        expect(mockTemplateCache.getTemplates).toHaveBeenCalledTimes(1)
        expect(mockPromptOptimizer.buildPrompt).toHaveBeenCalledWith("template-selection", "um livro", expect.any(Object))
        expect(mockChatCompletionsCreate).toHaveBeenCalledTimes(1)
    })

    it("should handle bulk auto-fill and transition to field-filling", async () => {
        mockChatCompletionsCreate.mockResolvedValueOnce({
            choices: [{ message: { content: '{"001": "12345", "101": {"a": "por"}}' } }],
            id: "chatcmpl-123",
            created: 123,
            model: "gpt-4o",
            object: "chat.completion",
        } as any)

        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    conversationState: {
                        step: "bulk-auto-fill",
                        currentTemplate: mockTemplate,
                        filledFields: {},
                        remainingFields: [],
                        autoFilledCount: 0,
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("bulk-auto-filled")
        expect(data.conversationState?.step).toBe("field-filling")
        expect(data.conversationState?.filledFields).toEqual({ "001": "12345", "101": { a: "por" } })
        expect(data.conversationState?.autoFilledCount).toBe(2)
        expect(mockPromptOptimizer.buildPrompt).toHaveBeenCalledWith("bulk-field-filling", "um livro", expect.any(Object))
    })

    it("should ask for the next field if not all fields are filled", async () => {
        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    conversationState: {
                        step: "field-filling",
                        currentTemplate: mockTemplate,
                        filledFields: { "001": "12345" },
                        remainingFields: ["003", "200", "101"], // Simplified for test
                        askedField: undefined,
                        askedSubfield: undefined,
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("field-question")
        expect(data.field).toBe("003")
        expect(data.question).toContain("IDENTIFICADOR DE REGISTO PERSISTENTE [003] (opcional)")
        expect(data.conversationState?.askedField).toBe("003")
    })

    it("should process user response for a simple field and ask for next", async () => {
        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    userResponse: "identificador-003",
                    conversationState: {
                        step: "field-filling",
                        currentTemplate: mockTemplate,
                        filledFields: { "001": "12345" },
                        remainingFields: ["003", "200", "101"],
                        askedField: "003",
                        askedSubfield: undefined,
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("field-question")
        expect(data.field).toBe("200") // Next field after 003
        expect(data.conversationState?.filledFields["003"]).toBe("identificador-003")
        expect(data.conversationState?.remainingFields).not.toContain("003")
    })

    it("should process user response for a data field with subfields", async () => {
        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    userResponse: "O Senhor dos Anéis",
                    conversationState: {
                        step: "field-filling",
                        currentTemplate: mockTemplate,
                        filledFields: { "001": "12345", "003": "identificador-003" },
                        remainingFields: ["200", "101"],
                        askedField: "200",
                        askedSubfield: "a", // Asking for subfield 'a' of 200
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("field-question")
        expect(data.field).toBe("200")
        expect(data.subfield).toBe("f") // Should ask for next subfield 'f' of 200
        expect(data.conversationState?.currentRepeatOccurrence?.subfields).toEqual({ a: "O Senhor dos Anéis" })
    })

    it('should handle "review-fields" command', async () => {
        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    userResponse: "__REVIEW_FIELDS__",
                    conversationState: {
                        step: "field-filling",
                        currentTemplate: mockTemplate,
                        filledFields: { "001": "12345", "200": { a: "Título" } },
                        remainingFields: ["003", "101"],
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("review-fields-display")
        expect(data.conversationState?.step).toBe("review-fields")
        expect(data.filledFields).toEqual({ "001": "12345", "200": { a: "Título" } })
    })

    it('should handle "edit-field" command and re-ask the field', async () => {
        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    userResponse: "__EDIT_FIELD__",
                    fieldToEdit: "001",
                    conversationState: {
                        step: "review-fields",
                        currentTemplate: mockTemplate,
                        filledFields: { "001": "OLD_VALUE", "200": { a: "Título" } },
                        remainingFields: ["003", "101"],
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("field-question")
        expect(data.field).toBe("001") // Should ask for 001 again
        expect(data.conversationState?.step).toBe("field-filling")
        expect(data.conversationState?.filledFields).not.toHaveProperty("001") // Value should be cleared
        expect(data.conversationState?.remainingFields[0]).toBe("001") // 001 should be first in remaining
    })

    it("should transition to confirmation if all fields are filled", async () => {
        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    conversationState: {
                        step: "field-filling",
                        currentTemplate: mockTemplate,
                        filledFields: {
                            "001": "12345",
                            "003": "identificador-003",
                            "200": { a: "Título", f: "Autor" },
                            "101": { a: "por" },
                            "210": { c: "Lisboa", d: "2023" },
                            "105": "data",
                            "205": "edicao",
                            "215": "descricao",
                            "225": "colecao",
                            "675": "assunto",
                            "700": "autor",
                            "801": "origem",
                        },
                        remainingFields: [], // All fields are filled
                        askedField: undefined,
                        askedSubfield: undefined,
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("record-complete")
        expect(data.conversationState?.step).toBe("confirmation")
        expect(data.record).toEqual(expect.any(Object))
    })

    it("should save the record and return record-saved type", async () => {
        mockChatCompletionsCreate.mockResolvedValueOnce({
            choices: [{ message: { content: "001 12345\n200 $aTítulo$fAutor" } }],
            id: "chatcmpl-123",
            created: 123,
            model: "gpt-4",
            object: "chat.completion",
        } as any)

        const req = {
            json: () =>
                Promise.resolve({
                    description: "um livro",
                    conversationState: {
                        step: "confirmation",
                        currentTemplate: mockTemplate,
                        filledFields: {
                            "001": "12345",
                            "200": { a: "Título", f: "Autor" },
                        },
                        remainingFields: [],
                    },
                }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("record-saved")
        expect(data.recordId).toBe("record123")
        expect(data.textUnimarc).toContain("001 12345")
        expect(mockDatabaseService.saveRecord).toHaveBeenCalledTimes(1)
        expect(mockDatabaseService.saveRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                templateId: mockTemplate.id,
                filledFields: { "001": "12345", "200": { a: "Título", f: "Autor" } },
                textUnimarc: "001 12345\n200 $aTítulo$fAutor",
            }),
        )
    })

    it("should handle template not found", async () => {
        mockChatCompletionsCreate.mockResolvedValueOnce({
            choices: [{ message: { content: "Template Inexistente" } }],
            id: "chatcmpl-123",
            created: 123,
            model: "gpt-4o",
            object: "chat.completion",
        } as any)

        const req = {
            json: () => Promise.resolve({ description: "um livro", conversationState: { step: "template-selection" } }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("template-not-found")
        expect(data.error).toContain("Template não identificado")
        expect(data.options).toEqual([{ name: "Livro", id: "temp1" }])
    })

    it("should handle invalid conversation state", async () => {
        const req = {
            json: () => Promise.resolve({ description: "um livro", conversationState: { step: "invalid-step" } }),
        } as any

        const res = await POST(req)
        const data: CatalogResponse = await res.json()

        expect(data.type).toBe("error")
        expect(data.error).toContain("Estado inválido da conversação.")
    })
})
