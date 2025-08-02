import "@testing-library/jest-dom"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import HomePage from "@/app/page"
import type { CatalogResponse, ConversationState } from "@/app/types/unimarc"

// Mock global fetch
global.fetch = jest.fn()

const mockFetch = (response: CatalogResponse, status = 200) => {
    (fetch as jest.Mock).mockResolvedValueOnce({
        json: () => Promise.resolve(response),
        status: status,
        ok: status >= 200 && status < 300,
    })
}

describe("HomePage", () => {
    beforeEach(() => {
        jest.clearAllMocks()
        jest.useFakeTimers()
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

    it("should start cataloging and display template selection", async () => {
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
        await userEvent.click(button)

        await waitFor(() => {
            expect(screen.getByText(/Template selecionado:/i)).toBeInTheDocument()
            expect(screen.getByText(/Livro/i)).toBeInTheDocument()
        })

        jest.advanceTimersByTime(1500)
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledTimes(1)
        })
    })

    it("should display bulk auto-filled fields and auto-continue", async () => {
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

        mockFetch({
            type: "template-selected",
            template: { id: "temp1", name: "Livro" },
            conversationState: {
                step: "bulk-auto-fill",
                filledFields: {},
                remainingFields: []
            } as ConversationState,
        })
        mockFetch(mockBulkAutoFilledResponse)

        render(<HomePage />)
        await userEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i }))

        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

        jest.advanceTimersByTime(1500)
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))

        await waitFor(() => {
            expect(screen.getByText(/Preenchimento Automático Concluído!/i)).toBeInTheDocument()
            expect(screen.getByText(/2 campos preenchidos automaticamente/i)).toBeInTheDocument()
        })
    })

    it("should display a field question and allow user input", async () => {
        const mockFieldQuestionResponse: CatalogResponse = {
            type: "field-question",
            field: "200",
            subfield: "a",
            question: "Por favor, forneça: Título [200]$a (obrigatório).",
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

        mockFetch({
            type: "template-selected",
            conversationState: { step: "bulk-auto-fill", filledFields: {} } as ConversationState,
        })
        mockFetch({
            type: "bulk-auto-filled",
            conversationState: {
                step: "field-filling",
                filledFields: { "001": "12345" },
                remainingFields: ["200"]
            } as ConversationState,
        })
        mockFetch(mockFieldQuestionResponse)

        render(<HomePage />)
        await userEvent.click(screen.getByRole("button", { name: /Iniciar Catalogação/i }))

        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
        jest.advanceTimersByTime(1500)
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
        jest.advanceTimersByTime(1500)
        await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3))

        await waitFor(() => {
            expect(screen.getByText(/Por favor, forneça: Título \[200\]\$a \(obrigatório\)\./i)).toBeInTheDocument()
        })

        const input = screen.getByPlaceholderText(/A sua resposta.../i)
        const sendButton = screen.getByRole("button", { name: /Enviar/i })

        const nextFieldQuestionResponse: CatalogResponse = {
            type: "field-question",
            field: "200",
            subfield: "f",
            question: "Por favor, forneça: Primeira responsabilidade [200]$f (opcional).",
            tips: [],
            subfieldTips: [],
            conversationState: {
                step: "field-filling",
                filledFields: { "001": "12345", "200": { a: "O Livro" } },
                remainingFields: ["200"],
                askedField: "200",
                askedSubfield: "f",
            } as ConversationState,
        }

        mockFetch(nextFieldQuestionResponse)

        await userEvent.type(input, "O Livro")
        await userEvent.click(sendButton)

        await waitFor(() => {
            expect(screen.getByText(/Primeira responsabilidade \[200\]\$f \(opcional\)\./i)).toBeInTheDocument()
        })
    })
})