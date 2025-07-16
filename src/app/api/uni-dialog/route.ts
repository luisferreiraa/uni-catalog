import { type NextRequest, NextResponse } from "next/server"
import OpenAI from "openai"
import { templateCache } from "@/lib/template-cache"
import { fieldInference } from "@/lib/field-heuristics"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type { CatalogRequest, CatalogResponse, ConversationState, DataField } from "@/app/types/unimarc"
import { databaseService } from "@/lib/database"

/**
 * Cliente OpenAI configurado com API Key
 * Utilizado para todas as interações com os modelos de IA
 */
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

/**
 * Handler principal da API de catalogação
 * Esta rota POST implementa um fluxo de conversação em várias etapas para:
 * 1. Selecionar o template apropriado com base na descrição do item
 * 2. Preencher campos automaticamente quando possível
 * 3. Solicitar informações adicionais ao utilizador quando necessário
 * 4. Confirmar e salvar o registo completo
 * 
 * @param req - Requisição Next.js contendo os dados do formulário
 * @returns Resposta JSON com o próximo passo do fluxo ou mensagem de erro
 */
export async function POST(req: NextRequest) {
    try {
        // Extrai e tipa os dados da requisição
        const { description, language = "pt", conversationState, userResponse }: CatalogRequest = await req.json()

        // Logs detalhados para debugging
        console.log("=== DEBUG API CALL ===")
        console.log("Description:", description)
        console.log("UserResponse:", userResponse)
        console.log("ConversationState (received):", JSON.stringify(conversationState, null, 2))

        // Obtém templates disponíveis do cache para melhor performance
        const { templates } = await templateCache.getTemplates()

        // Validação: Verifica se existem templates disponíveis
        if (templates.length === 0) {
            // Caso não haja templates, retornar erro 503 (serviço indisponível)
            return NextResponse.json(
                {
                    type: "error",
                    error: "Nenhum template disponível no momento.",
                } as CatalogResponse,
                { status: 503 },        // Service Unavailable
            )
        }

        /**
         * Inicializa ou clona o estado da conservação
         * Usamos JSON.parse/stringify para criar uma cópia profunda e evitar mutações acidentais
         * 
         * O estado contém:
         * - step: etapa atual do fluxo
         * - filledFields: campos já preenchidos
         * - remainingFields: campos pendentes
         * - autoFilledCount: contador de campos preenchidos automaticamente
         */
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
            /**
             * Constrói o prompt otimizado para seleção de template
             * O promtOptimizer ajusta:
             * - O texto do prompt com base no contexto
             * - A mensagem do sistema para guiar a IA
             * - Parâmetros como temperatura e maxTokens
             */
            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                "template-selection",
                description,
                { templates, language },
            )

            // Chama a API da OpenAI para determinar o template mais adequado
            const completion = await openai.chat.completions.create({
                model,
                messages: [
                    { role: "system", content: systemMessage },
                    { role: "user", content: prompt },
                ],
                temperature,        // Controla a criatividade da resposta
                max_tokens: maxTokens,      // Limita o tamanho da resposta
            })

            // Extrai e valida o template sugerido pela IA
            const templateName = completion.choices[0]?.message?.content?.trim()
            const selectedTemplate = templates.find((t) => t.name === templateName)

            // Fallback: Se a IA não identificar um template válido
            if (!selectedTemplate) {
                return NextResponse.json(
                    {
                        type: "template-not-found",
                        error: "Template não identificado. Escolha manualmente:",
                        options: templates.map((t) => ({ name: t.name, id: t.id })),
                    } as CatalogResponse,
                    { status: 400 },        // Bad request
                )
            }

            // Processa os campos do template selecionado:
            // 1. Obtém todos os campos obrigatórios
            // 2. Tenta preencher automaticamente com base na descrição
            // 3. Identifica campos restantes que precisam de intervenção manual
            const allTemplateFields = fieldInference.getAllTemplateFields(selectedTemplate)
            const autoFilled = fieldInference.inferFields(description, selectedTemplate)
            const remainingFields = allTemplateFields.filter((field) => !(field in autoFilled))

            console.log("All template fields:", allTemplateFields)
            console.log("Auto filled (initial):", autoFilled)
            console.log("Remaining after initial auto-fill:", remainingFields)

            // Retorna o template seleionado e o progresso inicial
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
            // Validade: Verifica se o template está definido
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            /**
             * Processa a resposta do utilizador a uma pergunta anterior, se existir
             * Adiciona a resposta ao estado e remove o campo da lista de pendentes
             */
            if (state.askedField && userResponse !== undefined && userResponse !== null) {
                console.log(`Processing user response for field ${state.askedField}: ${userResponse}`)
                state.filledFields[state.askedField] = userResponse.trim()
                state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                delete state.askedField     // Remove o campo perguntado do estado
                console.log("After user response - remaining fields:", state.remainingFields)
            }

            // Verifica se ainda há campo para preencher
            if (state.remainingFields.length > 0) {
                const nextField = state.remainingFields[0]
                console.log(`Attempting to process next field: ${nextField}`)

                /**
                 * Tenta preencher o campo automaticamente se possível
                 * Usa abordagens diferentes para campos de controlo vs campos de dados
                 */
                if (fieldInference.canAutoFill(nextField)) {
                    try {
                        console.log(`Trying to auto-fill field: ${nextField}`)

                        let fieldValue = ""
                        const controlField = state.currentTemplate.controlFields.find((f) => f.tag === nextField)

                        // Campos de controlo: preenchimento baseado em regras
                        if (controlField) {
                            fieldValue = fieldInference.generateControlFieldValue(nextField, description)
                        } else {
                            // Campos de dados: usar IA para gerar valor contextual
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

                        // Se obteve um valor válido, atualiza o estado
                        if (fieldValue && fieldValue.length > 0) {
                            state.filledFields[nextField] = fieldValue
                            state.remainingFields = state.remainingFields.filter((f) => f !== nextField)
                            state.autoFilledCount = (state.autoFilledCount || 0) + 1

                            console.log(`Field ${nextField} auto-filled with: ${fieldValue}`)
                            console.log("Remaining fields after auto-fill:", state.remainingFields)

                            // Notifica o frontend sobre o campo preenchido automaticamente
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
                        // Continua para perguntar manualmente em caso de erro
                    }
                }

                // Se não foi possível preencher automaticamente, prepara a pergunta ao utilizador
                console.log(`Asking user for field: ${nextField}`)

                // Encontra a definição completa do campo (controlo ou dados)
                const field = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === nextField,
                )

                // Obtém o nome traduzido do campo ou usa o código como fallback
                const fieldName = field?.translations.find((t) => t.language === language)?.name || nextField

                // Para campos de dados, adiciona informações sobre subcampos se disponível
                let subfieldInfo = ""
                if (field && "subFieldDef" in field && Array.isArray(field.subFieldDef)) {
                    const dataField = field as DataField
                    const mainSubfield = dataField.subFieldDef.find((sf) => sf.code === "a")
                    if (mainSubfield) {
                        subfieldInfo = ` (${mainSubfield.name})`
                    }
                }

                // Retorna a pergunta para o utilizador
                return NextResponse.json({
                    type: "field-question",
                    field: nextField,
                    question: `Por favor, forneça: ${fieldName}${subfieldInfo}`,
                    conversationState: {
                        ...state,
                        askedField: nextField,      // Marca qual o campo que está a ser perguntado
                    },
                } as CatalogResponse)
            }

            // Todos os campos foram preenchidos - avança para confirmação
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
                // Persiste o registo completo na base de dados
                console.log("Saving record to database...")
                const recordId = await databaseService.saveRecord({
                    templateId: state.currentTemplate.id,
                    templateName: state.currentTemplate.name,
                    templateDesc: `Registro catalogado automaticamente - ${new Date().toLocaleDateString()}`,
                    filledFields: state.filledFields,
                    template: state.currentTemplate,
                })

                console.log("Record saved with ID:", recordId)

                // Retorna confirmação de sucesso
                return NextResponse.json({
                    type: "record-saved",
                    message: `Registro gravado com sucesso! ID: ${recordId}. ${state.autoFilledCount || 0} campos preenchidos automaticamente.`,
                    record: state.filledFields,
                    recordId,
                    conversationState: {
                        ...state,
                        step: "completed",      // Marca o fluxo como concluído
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
                    { status: 500 },        // Internal Server Error
                )
            }
        }

        // Fallback para estado inválido/ não reconhecido
        return NextResponse.json(
            {
                type: "error",
                error: "Estado inválido da conversação.",
            } as CatalogResponse,
            { status: 400 },
        )
    } catch (error: any) {
        // Tratamento genérico de erros
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

