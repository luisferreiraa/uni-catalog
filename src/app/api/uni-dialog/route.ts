import { type NextRequest, NextResponse } from "next/server"
import OpenAI from "openai"
import { templateCache } from "@/lib/template-cache"
import { fieldInference } from "@/lib/field-heuristics"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type { CatalogRequest, CatalogResponse, ConversationState, DataField } from "@/app/types/unimarc"
import { databaseService } from "@/lib/database"

// Inicialização do cliente OpenAI com API Key
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

// Handler da rota POST (API route) que processa cada passo da catalogação
export async function POST(req: NextRequest) {
    try {
        // Extração do payload JSON recebido
        const { description, language = "pt", conversationState, userResponse }: CatalogRequest = await req.json()

        // Logs para debugging
        console.log("=== DEBUG API CALL ===")
        console.log("Description:", description)
        console.log("UserResponse:", userResponse)
        console.log("ConversationState (received):", JSON.stringify(conversationState, null, 2))

        // Busca de templates disponíveis (com uso de cache para desempenho)
        const { templates } = await templateCache.getTemplates()

        if (templates.length === 0) {
            // Caso não haja templates, retornar erro 503 (serviço indisponível)
            return NextResponse.json(
                {
                    type: "error",
                    error: "Nenhum template disponível no momento.",
                } as CatalogResponse,
                { status: 503 },
            )
        }

        // Inicializa o estado da conversa, caso seja o primeiro passo
        // Cópia profunda é feita para evitar mutações acidentais
        const state: ConversationState = conversationState
            ? JSON.parse(JSON.stringify(conversationState))
            : {
                step: "template-selection",
                filledFields: {},
                remainingFields: [],
                autoFilledCount: 0,
            }

        console.log("Current state (processed):", state.step)
        console.log("Filled fields (processed):", Object.keys(state.filledFields))
        console.log("Remaining fields (processed):", state.remainingFields)

        // ETAPA 1: Seleção de Template
        if (state.step === "template-selection") {
            // Geração de prompt otimizado para escolher o template ideal
            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                "template-selection",
                description,
                { templates, language },
            )

            // Chamada à OpenAI para sugerir o melhor template
            const completion = await openai.chat.completions.create({
                model,
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: prompt },
                ],
                temperature,
                max_tokens: maxTokens,
            })

            const templateName = completion.choices[0]?.message?.content?.trim()
            const selectedTemplate = templates.find((t) => t.name === templateName)

            // Caso a IA não consiga identificar o template corretamente
            if (!selectedTemplate) {
                return NextResponse.json(
                    {
                        type: "template-not-found",
                        error: "Template não identificado. Escolha manualmente:",
                        options: templates.map((t) => ({ name: t.name, id: t.id })),
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            // Inferência de campos automaticamente com base na descrição
            const allTemplateFields = fieldInference.getAllTemplateFields(selectedTemplate)
            const autoFilled = fieldInference.inferFields(description, selectedTemplate)
            const remainingFields = allTemplateFields.filter((field) => !(field in autoFilled))

            console.log("All template fields:", allTemplateFields)
            console.log("Auto filled (initial):", autoFilled)
            console.log("Remaining after initial auto-fill:", remainingFields)

            return NextResponse.json({
                type: "template-selected",
                conversationState: {
                    step: "field-filling",
                    currentTemplate: selectedTemplate,
                    filledFields: autoFilled,
                    remainingFields,
                    autoFilledCount: Object.keys(autoFilled).length,
                },
                template: {
                    id: selectedTemplate.id,
                    name: selectedTemplate.name,
                    description: `${Object.keys(autoFilled).length} de ${allTemplateFields.length} campos preenchidos automaticamente`,
                },
            } as CatalogResponse)
        }

        // ETAPA 2: Preenchimento de Campos
        if (state.step === "field-filling") {
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            // Verifica se há resposta do utilizador a uma pergunta anterior
            if (state.askedField && userResponse !== undefined && userResponse !== null) {
                console.log(`Processing user response for field ${state.askedField}: ${userResponse}`)
                state.filledFields[state.askedField] = userResponse.trim()
                state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                delete state.askedField     // Remove o campo perguntado do estado
                console.log("After user response - remaining fields:", state.remainingFields)
            }

            // Se ainda há campos para preencher
            if (state.remainingFields.length > 0) {
                const nextField = state.remainingFields[0]
                console.log(`Attempting to process next field: ${nextField}`)

                // Tenta preencher automaticamente o campo
                if (fieldInference.canAutoFill(nextField)) {
                    try {
                        console.log(`Trying to auto-fill field: ${nextField}`)

                        let fieldValue = ""
                        const controlField = state.currentTemplate.controlFields.find((f) => f.tag === nextField)

                        if (controlField) {
                            // Campo de controlo: preenchimento heurístico
                            fieldValue = fieldInference.generateControlFieldValue(nextField, description)
                        } else {
                            // Campos de dados: usar OpenAI para gerar valor
                            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                                "field-filling",
                                description,
                                {
                                    currentTemplate: state.currentTemplate,
                                    filledFields: state.filledFields,
                                    remainingFields: [nextField],
                                    language,
                                },
                            )

                            const completion = await openai.chat.completions.create({
                                model,
                                messages: [
                                    { role: "system", content: systemMessage },
                                    { role: "user", content: prompt },
                                ],
                                temperature,
                                max_tokens: maxTokens,
                            })

                            fieldValue = completion.choices[0]?.message?.content?.trim() || ""
                        }

                        console.log(`Auto-fill result for field ${nextField}:`, fieldValue)

                        if (fieldValue && fieldValue.length > 0) {
                            state.filledFields[nextField] = fieldValue
                            state.remainingFields = state.remainingFields.filter((f) => f !== nextField)
                            state.autoFilledCount = (state.autoFilledCount || 0) + 1

                            console.log(`Field ${nextField} auto-filled with: ${fieldValue}`)
                            console.log("Remaining fields after auto-fill:", state.remainingFields)

                            // Retorna para o frontend para atualizar interface
                            return NextResponse.json({
                                type: "field-auto-filled",
                                field: nextField,
                                value: fieldValue,
                                conversationState: state,
                            } as CatalogResponse)
                        } else {
                            console.log(`Auto-fill failed for field ${nextField}, will ask user.`)
                        }
                    } catch (error) {
                        console.warn(`Erro no preenchimento automático do campo ${nextField}:`, error)
                        // Continua para perguntar manualmente
                    }
                }

                // Se não conseguiu preencher automaticamente, pergunta ao utilizador
                console.log(`Asking user for field: ${nextField}`)

                const field = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === nextField,
                )

                const fieldName = field?.translations.find((t) => t.language === language)?.name || nextField

                let subfieldInfo = ""
                if (field && "subFieldDef" in field && Array.isArray(field.subFieldDef)) {
                    const dataField = field as DataField
                    const mainSubfield = dataField.subFieldDef.find((sf) => sf.code === "a")
                    if (mainSubfield) {
                        subfieldInfo = ` (${mainSubfield.name})`
                    }
                }

                return NextResponse.json({
                    type: "field-question",
                    field: nextField,
                    question: `Por favor, forneça: ${fieldName}${subfieldInfo}`,
                    conversationState: {
                        ...state,
                        askedField: nextField,
                    },
                } as CatalogResponse)
            }

            // Se todos os campos foram preenchidos, avança para confirmação
            console.log("All fields filled, moving to confirmation")
            state.step = "confirmation"
            return NextResponse.json({
                type: "record-complete",
                record: state.filledFields,
                conversationState: state,
                template: {
                    id: state.currentTemplate.id,
                    name: state.currentTemplate.name,
                },
            } as CatalogResponse)
        }

        // ETAPA 3: Confirmação e Gravação na Base de Dados
        if (state.step === "confirmation") {
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado para gravação.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            try {
                console.log("Saving record to database...")
                const recordId = await databaseService.saveRecord({
                    templateId: state.currentTemplate.id,
                    templateName: state.currentTemplate.name,
                    templateDesc: `Registro catalogado automaticamente - ${new Date().toLocaleDateString()}`,
                    filledFields: state.filledFields,
                    template: state.currentTemplate,
                })

                console.log("Record saved with ID:", recordId)

                return NextResponse.json({
                    type: "record-saved",
                    message: `Registro gravado com sucesso! ID: ${recordId}. ${state.autoFilledCount || 0} campos preenchidos automaticamente.`,
                    record: state.filledFields,
                    recordId,
                    conversationState: {
                        ...state,
                        step: "completed",
                    },
                } as CatalogResponse)
            } catch (error) {
                console.error("Erro ao gravar registro:", error)
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Erro ao gravar registro na base de dados.",
                        details: error instanceof Error ? error.message : "Erro desconhecido",
                    } as CatalogResponse,
                    { status: 500 },
                )
            }
        }

        // Se o estado não for reconhecido, retorna erro
        return NextResponse.json(
            {
                type: "error",
                error: "Estado inválido da conversação.",
            } as CatalogResponse,
            { status: 400 },
        )
    } catch (error: any) {
        console.error("Erro na API:", error)
        return NextResponse.json(
            {
                type: "error",
                error: "Erro interno no servidor",
                details: error.message,
            } as CatalogResponse,
            { status: 500 },
        )
    }
}

