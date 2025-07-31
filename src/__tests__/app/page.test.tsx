import { render, screen, fireEvent, waitFor, getByText } from "@testing-library/react"
import "@testing-library/jest-dom"
import userEvent from "@testing-library/user-event"
import HomePage from "@/app/page"
import type { CatalogResponse, ConversationState } from "@/app/types/unimarc"
import { mock } from "node:test"

// Mock the global fetch
global.fetch = jest.fn()

const mockFetch = (response: CatalogResponse, status = 200) => {
    ; (fetch as jest.Mock).mockResolvedValueOnce({
        json: () => Promise.resolve(response),
        status: status,
        ok: status >= 200 && status < 300,
    })
}

describe("HomePage", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        jest.useFakeTimers()    // Use fake timers for setTimeout in useEffects
    })

    afterEach(() => {
        jest.runOnlyPendingTimers()
        jest.useRealTimers()
    })

    it("should render the initial input and button", () => {
        render(<HomePage />)
        expect(screen.getByPlaceholderText(/Ex: Livro 'Memorial do Convento'/i)).toBeInTheDocument()
        expect(screen.getByRole("button", { name: /Iniciar Catalogação/i })).toBeInTheDocument()
    })

    it("should start cataloging  and display template selection", async () => {
        const initialDescription = "um livro de teste"
        const mockTemplateSelectedResponse: CatalogResponse = {
            type: "template-selected",
            template: { id: "temp1", name: "Livro", description: "Template selecionado: Livro" },
            conversationState: {
                step: "bulk-auto-fill",
                filledFields: {},
                remainingFields: [],
                autoFilledCount: 0,
            } as ConversationState,
        }

        mockFetch(mockTemplateSelectedResponse)

        render(<HomePage />)
        const input = screen.getByPlaceholderText(/Ex: Livro 'Memorial do Convento'/i)
        const button = screen.getByRole("button", { name: /Iniciar Catalogação/i })

        await userEvent.type(input, initialDescription)
        fireEvent.click(button)

        await waitFor(() => {
            expect(screen.getByText(/Template selecionado:/i)).toBeInTheDocument()
            expect(screen.getByText(/Livro/i)).toBeInTheDocument()
            expect(screen.getByText(/bulk-autto-fill/i)).toBeInTheDocument()
        })

        // Simulate auto-continuation
        jest.advanceTimersByTime(1500)

        await waitFor(() => {
            expect(fetch).toHaveBeenCalledTimes(2)      // Initial + auto-continue
        })
    })

    it("should display bulk auto-filleed fields and auto-continue", async () => {
        const mockBulkAutoFilledResponse: CatalogResponse = {
            type: "bulk-auto-filled",
            message: "2 campos preenchidos automaticamente",
            filledFields: { "001": "12345", "101": { a: "por" } },
            conversationState: {
                step: "field-filling",
                filledFields: { "001": "12345", "101": { a: "por" } },
                remainingFields: ["200"],
                autoFilledCount: 2,
            } as ConversationState,
        }

        // First call for template selection, second for bulk auto-fill
        mockFetch({ type: "template-selected", conversationState: { step: "bulk-auto-fill" } as ConversationState })
        mockFetch(mockBulkAutoFilledResponse)

        render(<HomePage />)
        fireEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i })) // Trigger inicial
        jest.advanceTimersByTime(1500)  // Auto-continue from template-selected

        await waitFor(() => {
            expect(screen.getByText(/Preenchimento Automático Concluído!/i)).toBeInTheDocument()
            expect(screen.getByText(/2 campos preenchidos automaticamente/i)).toBeInTheDocument()
            expect(screen.getByText(/field-filling/i)).toBeInTheDocument()
        })

        // Simulate auto-continuation
        jest.advanceTimersByTime(1500)

        await waitFor(() => {
            expect(fetch).toHaveBeenCalledTimes(3)  // Initial + template-selectec auto-continue + bulk-auto-filled auto continue
        })
    })

    it("should display a field question and allow user input", async () => {
        const mockFieldQuestionResponse: CatalogResponse = {
            type: "field-question",
            field: "200",
            subfield: "a",
            question: "Por favor, forneça: Título (200$a) (obrigatório)",
            tips: [],
            conversationState: {
                step: "field-filling",
                filledFields: { "001": "12345" },
                remainingFields: ["200"],
                askedField: "200",
                askedSubfield: "a"
            } as ConversationState,
        }

        // Simulate previous steps leading to field-question
        mockFetch({ type: "template-selected", conversationState: { step: "bulk-auto-fill" } as ConversationState })
        mockFetch({ type: "bulk-auto-filled", conversationState: { step: "field-filling" } as ConversationState })
        mockFetch(mockFieldQuestionResponse)

        render(<HomePage />)
        fireEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i }))
        jest.advanceTimersByTime(1500)
        jest.advanceTimersByTime(1500)

        await waitFor(() => {
            expect(screen.getByText(/Por favor, forneça: Título $$200\$a$$ $$obrigatório$$./i)).toBeInTheDocument()
            expect(screen.getByPlaceholderText(/A sua resposta.../i)).toBeInTheDocument()
            expect(screen.getByRole("button", { name: /Enviar/i })).toBeInTheDocument()
        })

        const input = screen.getByPlaceholderText(/A sua resposta.../i)
        const sendButton = screen.getByRole("button", { name: /Enviar/i })

        mockFetch({
            type: "field-question",
            field: "200",
            subfield: "f",
            question: "Por favor, forneça: Primeira responsabilidade (200$f) (opcional).",
            tips: [],
            subfieldTips: [],
            conversationState: {
                step: "field-filling",
                filledFields: { "001": "12345", "200": { a: "O Livro" } },
                remainingFields: ["200"],
                askedField: "200",
                askedSubfield: "f",
            } as ConversationState,
        })

        await userEvent.type(input, "O Livro")
        fireEvent.click(sendButton)

        await waitFor(() => {
            expect(
                screen.getByText(/Por favor, forneça: Primeira responsabilidade $$200\$f$$ $$opcional$$./i),
            ).toBeInTheDocument()
        })
    })

    it('should display "Review  and Edit Fields" button and switch to review mode', async () => {
        const mockFieldQuestionResponse: CatalogResponse = {
            type: "field-question",
            field: "200",
            subfield: "a",
            question: "Por favor, forneça: Título (200$a) (obrigatório).",
            tips: [],
            subfieldTips: [],
            conversationState: {
                step: "field-filling",
                filledFields: { "001": "12345" },
                remainingFields: ["200"],
                askedField: "200",
                askedSubfield: "a",
            } as ConversationState,
        }

        const mockReviewFieldsResponse: CatalogResponse = {
            type: "review-fields-display",
            filledFields: { "001": "12345", "200": { a: "Título" } },
            conversationState: {
                step: "review-fields",
                filledFields: { "001": "12345", "200": { a: "Título" } },
                remainingFields: ["200"],
            } as ConversationState,
        }

        // Simulate previous steps
        mockFetch({ type: "template-selected", conversationState: { step: "bulk-auto-fill" } as ConversationState })
        mockFetch({ type: "bulk-auto-filled", conversationState: { step: "field-filling" } as ConversationState })
        mockFetch(mockFieldQuestionResponse)    // Current State: asking for 200$a

        render(<HomePage />)
        fireEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i }))
        jest.advanceTimersByTime(1500)  // Auto-continue
        jest.advanceTimersByTime(1500)  // Auto-continue

        await waitFor(() => {
            expect(screen.getByRole("button", { name: /Rever e Editar Campos/i })).toBeInTheDocument()
        })

        mockFetch(mockReviewFieldsResponse)
        fireEvent.click(screen.getByRole("button", { name: /Rever e Editar Campos/i }))

        await waitFor(() => {
            expect(screen.getByText(/Campos Preenchidos:/i)).toBeInTheDocument()
            expect(screen.getByText(/001/i)).toBeInTheDocument()
            expect(screen.getByText(/12345/i)).toBeInTheDocument()
            expect(screen.getByText(/200/i)).toBeInTheDocument()
            expect(screen.getByText(/{"a":"Título"}/i)).toBeInTheDocument() // JSON stringified
            expect(screen.getByRole("button", { name: /Continuar Catalogação/i })).toBeInTheDocument()
        })
    })

    it("should allow editing a field from review mode", async () => {
        const mockReviewFieldsResponse: CatalogResponse = {
            type: "review-fields-display",
            filledFields: { "001": "OLD_VALUE", "200": { a: "Título" } },
            conversationState: {
                step: "review-fields",
                filledFields: { "001": "OLD_VALUE", "200": { a: "Título" } },
                remainingFields: ["200"],
            } as ConversationState,
        }

        const mockEditFieldResponse: CatalogResponse = {
            type: "field-question",
            field: "001",
            question: "Por favor, forneça: Identificador [001] (obrigatório).",
            tips: [],
            subfieldTips: [],
            conversationState: {
                step: "field-filling",
                filledFields: { "200": { a: "Título" } }, // 001 removed
                remainingFields: ["001", "200"], // 001 added back to remaining
                askedField: "001",
            } as ConversationState,
        }

        // Simulate previous steps leading to review mode
        mockFetch({ type: "template-selected", conversationState: { step: "bulk-auto-fill" } as ConversationState })
        mockFetch({ type: "bulk-auto-filled", conversationState: { step: "field-filling" } as ConversationState })
        mockFetch({ type: "field-question", conversationState: { step: "field-filling" } as ConversationState }) // Just to get to a state where review button appears
        mockFetch(mockReviewFieldsResponse) // Trigger review mode

        render(<HomePage />)
        fireEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i }))
        jest.advanceTimersByTime(1500) // Auto-continue
        jest.advanceTimersByTime(1500) // Auto-continue
        jest.advanceTimersByTime(1500) // Auto-continue
        fireEvent.click(screen.getByRole("button", { name: /Rever e Editar Campos/i }))

        await waitFor(() => {
            expect(screen.getByText(/OLD_VALUE/i)).toBeInTheDocument()
            expect(screen.getAllByRole("button", { name: /Editar/i })[0]).toBeInTheDocument()
        })

        mockFetch(mockEditFieldResponse)
        fireEvent.click(screen.getAllByRole("button", { name: /Editar/i })[0]) // Click edit for 001

        await waitFor(() => {
            expect(screen.getByText(/Por favor, forneça: Identificador \[001\] $$obrigatório$$./i)).toBeInTheDocument()
            expect(screen.getByPlaceholderText(/A sua resposta.../i)).toBeInTheDocument()
            expect(fetch).toHaveBeenCalledWith(
                "/api/uni-dialog",
                expect.objectContaining({
                    body: expect.stringContaining('"userResponse":"__EDIT_FIELD__","fieldToEdit":"001"'),
                }),
            )
        })
    })

    it("should display record saved message and UNIMARC text", async () => {
        const mockRecordSavedResponse: CatalogResponse = {
            type: "record-saved",
            message: "Registo gravado com sucesso! ID: record123.",
            recordId: "record123",
            textUnimarc: "001 12345\n200 $aTítulo",
            conversationState: { step: "completed" } as ConversationState,
        }

        // Simulate previous steps leading to record-complete, then user confirms
        mockFetch({ type: "template-selected", conversationState: { step: "bulk-auto-fill" } as ConversationState })
        mockFetch({ type: "bulk-auto-filled", conversationState: { step: "field-filling" } as ConversationState })
        mockFetch({ type: "record-complete", conversationState: { step: "confirmation" } as ConversationState })
        mockFetch(mockRecordSavedResponse) // User confirms

        render(<HomePage />)
        fireEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i }))
        jest.advanceTimersByTime(1500) // Auto-continue
        jest.advanceTimersByTime(1500) // Auto-continue
        fireEvent.click(screen.getByRole("button", { name: /Confirmar e Gravar/i }))

        await waitFor(() => {
            expect(screen.getByText(/Registo gravado com sucesso! ID: record123./i)).toBeInTheDocument()
            expect(screen.getByText(/UNIMARC gerado:/i)).toBeInTheDocument()
            expect(screen.getByText(/001 12345\n200 \$aTítulo/i)).toBeInTheDocument()
            expect(screen.getByRole("button", { name: /Iniciar Nova Catalogação/i })).toBeInTheDocument()
        })
    })
})