import { type NextRequest, NextResponse } from "next/server"
import OpenAI from "openai"
import { templateCache } from "@/lib/template-cache"
import { fieldInference } from "@/lib/field-heuristics"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type {
    CatalogRequest,
    CatalogResponse,
    ConversationState,
    DataField,
    SubFieldDef,
    Translation,
    FieldDefinition, // Importar FieldDefinition
} from "@/app/types/unimarc"
import { databaseService } from "@/lib/database"
import { FieldType, type Prisma } from "@prisma/client"

export const runtime = "nodejs"

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

// MODIFICADO: isValidFieldValue para lidar com arrays (subcampos repetíveis)
function isValidFieldValue(value: any, fieldDef?: any): boolean {
    if (value === undefined || value === null) return false
    if (typeof value === "string") {
        const trimmed = value.trim()
        if (trimmed.length === 0) return false
        if (["n/a", "não se aplica", "não", "nao", "-", "none", "null"].includes(trimmed.toLowerCase())) {
            return fieldDef?.mandatory // Only accept if field is mandatory
        }
        return true
    }
    if (Array.isArray(value)) {
        // This branch is for when 'value' itself is an array (e.g., a repeatable simple field, or a repeatable subfield's value)
        return value.some((item) => isValidFieldValue(item, fieldDef))
    }
    if (typeof value === "object") {
        // This branch is for when 'value' is an object (e.g., subfields of a data field)
        return Object.values(value).some((v) => isValidFieldValue(v, fieldDef))
    }
    return false
}

export async function POST(req: NextRequest) {
    try {
        const {
            description,
            language = "pt",
            conversationState,
            userResponse,
            fieldToEdit,
        }: CatalogRequest = await req.json() // Adicionado fieldToEdit

        console.log("=== DEBUG API CALL ===")
        console.log("Description:", description)
        console.log("UserResponse (raw from payload):", userResponse)
        console.log("FieldToEdit (from payload):", fieldToEdit) // NOVO LOG
        console.log("ConversationState (received):", JSON.stringify(conversationState, null, 2))

        const { templates } = await templateCache.getTemplates()
        if (templates.length === 0) {
            return NextResponse.json(
                {
                    type: "error",
                    error: "Nenhum template disponível no momento.",
                } as CatalogResponse,
                { status: 503 },
            )
        }

        const state: ConversationState = conversationState
            ? JSON.parse(JSON.stringify(conversationState))
            : {
                step: "template-selection",
                filledFields: {},
                remainingFields: [],
                autoFilledCount: 0,
                repeatingField: false,
                repeatConfirmation: undefined,
                currentRepeatOccurrence: undefined,
            }

        console.log("Current state (processed):", state.step)
        console.log("Filled fields (processed):", Object.keys(state.filledFields))
        console.log("Remaining fields (processed):", state.remainingFields)

        // ============================================
        // Lógica de Revisão/Edição de Campos (NOVO)
        // ============================================
        if (userResponse === "__REVIEW_FIELDS__") {
            console.log("=== ENTERING REVIEW FIELDS MODE ===")
            state.step = "review-fields"
            console.log("DEBUG: State after entering review mode:", JSON.stringify(state, null, 2)) // NOVO LOG
            return NextResponse.json({
                type: "review-fields-display",
                filledFields: state.filledFields,
                conversationState: state,
            } as CatalogResponse)
        }

        if (userResponse === "__EDIT_FIELD__" && fieldToEdit) {
            console.log(`=== PROCESSING EDIT FIELD COMMAND: ${fieldToEdit} ===`)
            console.log("DEBUG: State BEFORE edit processing:", JSON.stringify(state, null, 2)) // NOVO LOG
            // Remove o campo dos filledFields para que possa ser preenchido novamente
            delete state.filledFields[fieldToEdit]
            // Adiciona o campo de volta aos remainingFields (se não estiver lá)
            // Certifica-se de que o campo a ser editado é o primeiro na lista de remainingFields
            state.remainingFields = state.remainingFields.filter((f) => f !== fieldToEdit) // Remove se já estiver
            state.remainingFields.unshift(fieldToEdit) // Adiciona no início

            // Redefine o estado para perguntar este campo
            state.askedField = fieldToEdit
            state.askedSubfield = undefined // Começa do primeiro subcampo, se houver
            state.repeatingField = false
            state.currentRepeatOccurrence = undefined
            state.step = "field-filling" // Volta para o passo de preenchimento individual
            console.log(`DEBUG: Field ${fieldToEdit} removed from filledFields and added to remainingFields.`)
            console.log("DEBUG: State AFTER edit processing:", JSON.stringify(state, null, 2))
            // Não retorna aqui, deixa o fluxo continuar para a lógica de field-filling para perguntar o campo.
        }

        if (userResponse === "__CONTINUE_FROM_REVIEW__") {
            console.log("=== CONTINUING FROM REVIEW MODE ===")
            // Se todos os campos já estavam preenchidos, vai para confirmação, senão continua a preencher
            if (state.remainingFields.length === 0) {
                state.step = "confirmation"
            } else {
                state.step = "field-filling"
            }
            console.log("DEBUG: State after continuing from review:", JSON.stringify(state, null, 2)) // NOVO LOG
            // Não retorna aqui, deixa o fluxo continuar para a lógica de field-filling ou confirmation.
        }

        // ============================================
        // ETAPA 1: Seleção de Template
        // ============================================
        if (state.step === "template-selection") {
            console.log("=== INICIANDO SELEÇÃO DE TEMPLATE ===")
            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                "template-selection",
                description,
                { templates, language },
            )

            console.log("Template selection prompt:", prompt)
            console.log(
                "Available templates:",
                templates.map((t) => t.name),
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

            const templateName = completion.choices[0]?.message?.content?.trim()
            console.log("OpenAI selected template:", templateName)

            const selectedTemplate = templates.find((t) => t.name === templateName)
            console.log("Found template:", selectedTemplate ? selectedTemplate.name : "NOT FOUND")

            if (!selectedTemplate) {
                console.log("=== TEMPLATE NOT FOUND - RETURNING OPTIONS ===")
                return NextResponse.json(
                    {
                        type: "template-not-found",
                        error: "Template não identificado. Escolha manualmente:",
                        options: templates.map((t) => ({ name: t.name, id: t.id })),
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            console.log("=== TEMPLATE SELECTED - ADVANCING TO BULK AUTO-FILL ===")
            console.log("Selected template ID:", selectedTemplate.id)
            console.log("Selected template name:", selectedTemplate.name)

            const response = {
                type: "template-selected" as const,
                conversationState: {
                    step: "bulk-auto-fill" as const,
                    currentTemplate: selectedTemplate,
                    filledFields: {},
                    remainingFields: [],
                    autoFilledCount: 0,
                    repeatingField: false,
                    repeatConfirmation: undefined,
                    currentRepeatOccurrence: undefined,
                },
                template: {
                    id: selectedTemplate.id,
                    name: selectedTemplate.name,
                    description: `Template selecionado: ${selectedTemplate.name}`,
                },
            } as CatalogResponse

            console.log("=== RETURNING TEMPLATE SELECTION RESPONSE ===")
            console.log("Response type:", response.type)
            console.log("Next step:", response.conversationState?.step)

            return NextResponse.json(response)
        }

        // ============================================
        // ETAPA 2: Preenchimento Automático em Massa
        // ============================================
        if (state.step === "bulk-auto-fill") {
            console.log("=== INICIANDO PREENCHIMENTO AUTOMÁTICO EM MASSA ===")
            if (!state.currentTemplate) {
                console.log("ERROR: No current template found")
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            console.log("Current template for bulk fill:", state.currentTemplate.name)
            console.log("Template has control fields:", state.currentTemplate.controlFields.length)
            console.log("Template has data fields:", state.currentTemplate.dataFields.length)

            try {
                const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                    "bulk-field-filling",
                    description,
                    { currentTemplate: state.currentTemplate, language },
                )

                console.log("Bulk filling prompt:", prompt.substring(0, 200) + "...")
                console.log("Using model:", model)

                const completion = await openai.chat.completions.create({
                    model,
                    messages: [
                        { role: "system", content: systemMessage },
                        { role: "user", content: prompt },
                    ],
                    temperature,
                    max_tokens: maxTokens,
                })

                const aiResponse = completion.choices[0]?.message?.content?.trim() || ""
                console.log("AI Response for bulk filling:", aiResponse)

                let bulkFilledFields: Record<string, any> = {}
                try {
                    const cleanResponse = aiResponse.replace(/```json\n?|\n?```/g, "").trim()
                    bulkFilledFields = JSON.parse(cleanResponse)
                    console.log("Parsed bulk filled fields:", bulkFilledFields)
                } catch (parseError) {
                    console.warn("Erro ao fazer parse do JSON da OpenAI:", parseError)
                    console.warn("Resposta original:", aiResponse)
                }

                const validatedFields: Record<string, any> = {}
                let autoFilledCount = 0

                // NEW LOG: Log template fields before validation loop
                console.log(
                    "Template control fields for validation:",
                    state.currentTemplate.controlFields.map((f) => f.tag),
                )
                console.log(
                    "Template data fields for validation:",
                    state.currentTemplate.dataFields.map((f) => f.tag),
                )

                for (const [tag, value] of Object.entries(bulkFilledFields)) {
                    const fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                        (f) => f.tag === tag,
                    )
                    if (!fieldDef) {
                        console.warn(`Campo ${tag} não existe no template, ignorando`)
                        continue
                    }
                    // NEW LOG: Log field validation
                    console.log(
                        `Validating field ${tag}. Value: ${JSON.stringify(value)}. Is valid: ${isValidFieldValue(value, fieldDef)}. Field is repeatable: ${fieldDef.repeatable}`,
                    )

                    if (isValidFieldValue(value, fieldDef)) {
                        if (typeof value === "object" && !Array.isArray(value)) {
                            // Filter out invalid subfields for data fields
                            const filteredValue: Record<string, any> = {}
                            for (const [subcode, subvalue] of Object.entries(value)) {
                                if (isValidFieldValue(subvalue)) {
                                    filteredValue[subcode] = subvalue
                                }
                            }
                            if (Object.keys(filteredValue).length > 0) {
                                if (fieldDef.repeatable) {
                                    if (!Array.isArray(validatedFields[tag])) {
                                        validatedFields[tag] = []
                                    }
                                    ; (validatedFields[tag] as any[]).push(filteredValue)
                                } else {
                                    validatedFields[tag] = filteredValue
                                }
                                autoFilledCount++
                            }
                        } else if (Array.isArray(value)) {
                            // Handle arrays for repeatable fields from bulk fill
                            if (fieldDef.repeatable) {
                                validatedFields[tag] = []
                                for (const item of value) {
                                    if (typeof item === "object") {
                                        // Array of subfield objects
                                        const filteredItem: Record<string, any> = {}
                                        for (const [subcode, subvalue] of Object.entries(item)) {
                                            if (isValidFieldValue(subvalue)) {
                                                filteredItem[subcode] = subvalue
                                            }
                                        }
                                        if (Object.keys(filteredItem).length > 0) {
                                            ; (validatedFields[tag] as any[]).push(filteredItem)
                                            autoFilledCount++
                                        }
                                    } else {
                                        // Array of simple values
                                        if (isValidFieldValue(item)) {
                                            ; (validatedFields[tag] as any[]).push(item)
                                            autoFilledCount++
                                        }
                                    }
                                }
                            } else {
                                console.warn(`Campo ${tag} não é repetível, mas recebeu um array. Ignorando array.`)
                            }
                        } else {
                            // Simple field value
                            if (fieldDef.repeatable) {
                                if (!Array.isArray(validatedFields[tag])) {
                                    validatedFields[tag] = []
                                }
                                ; (validatedFields[tag] as any[]).push(value)
                            } else {
                                validatedFields[tag] = value
                            }
                            autoFilledCount++
                        }
                        console.log(`Campo ${tag} preenchido automaticamente:`, value)
                    } else {
                        console.log(`Campo ${tag} com valor inválido, será perguntado ao utilizador:`, value)
                    }
                }

                const allTemplateFields = fieldInference.getAllTemplateFields(state.currentTemplate)
                // NEW LOG: Log allTemplateFields and remainingFields after bulk fill
                console.log("All template fields (from inference):", allTemplateFields)
                console.log("Validated fields after bulk fill:", Object.keys(validatedFields))
                const remainingFields = allTemplateFields.filter((field) => !(field in validatedFields))
                console.log("Remaining fields after bulk fill (before state update):", remainingFields)

                state.filledFields = validatedFields
                state.remainingFields = remainingFields
                state.autoFilledCount = autoFilledCount
                state.step = "field-filling"

                if (autoFilledCount > 0) {
                    console.log("=== RETURNING BULK AUTO-FILLED RESPONSE ===")
                    return NextResponse.json({
                        type: "bulk-auto-filled",
                        message: `${autoFilledCount} campos preenchidos automaticamente`,
                        filledFields: validatedFields,
                        conversationState: state,
                    } as CatalogResponse)
                } else {
                    console.log("=== NO FIELDS AUTO-FILLED, CONTINUING TO MANUAL FILLING ===")
                    state.step = "field-filling"
                }
            } catch (error) {
                console.error("Erro no preenchimento automático em massa:", error)
                const allTemplateFields = fieldInference.getAllTemplateFields(state.currentTemplate)
                state.remainingFields = allTemplateFields
                state.step = "field-filling"
            }
        }

        // ===================================
        // ETAPA 3: Preenchimento de Campos Individual
        // ===================================
        if (state.step === "field-filling") {
            console.log("=== INICIANDO PREENCHIMENTO INDIVIDUAL DE CAMPOS ===")
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            console.log("Remaining fields to fill:", state.remainingFields)
            console.log("Currently asked field:", state.askedField)
            console.log("User response received:", userResponse)

            // Verifica se a userResponse é um comando especial que já foi tratado
            const isSpecialCommand = ["__EDIT_FIELD__", "__CONTINUE_FROM_REVIEW__"].includes(userResponse || "")

            // 1. Processa resposta do utilizador a uma CONFIRMAÇÃO de repetição (se existir)
            if (state.repeatConfirmation && userResponse !== undefined && userResponse !== null) {
                const wantsToRepeat = userResponse.trim().toLowerCase() === "sim"
                const fieldToRepeatTag = state.repeatConfirmation.field
                const subfieldToRepeatCode = state.repeatConfirmation.subfield

                delete state.repeatConfirmation // Consome o pedido de confirmação
                state.repeatingField = wantsToRepeat // Define repeatingField com base na escolha do utilizador

                if (wantsToRepeat) {
                    console.log(
                        `User wants to repeat ${fieldToRepeatTag}${subfieldToRepeatCode ? "$" + subfieldToRepeatCode : ""}`,
                    )
                    // Define askedField/askedSubfield de volta para o que está a ser repetido
                    state.askedField = fieldToRepeatTag
                    state.askedSubfield = subfieldToRepeatCode
                    // Não retorna aqui. O loop 'while' abaixo irá gerar a pergunta para o campo/subcampo repetido.
                } else {
                    console.log(
                        `User does not want to repeat ${fieldToRepeatTag}${subfieldToRepeatCode ? "$" + subfieldToRepeatCode : ""}`,
                    )
                    // Se o utilizador disse NÃO, avança para o próximo campo/subcampo lógico
                    if (subfieldToRepeatCode) {
                        // Se foi uma repetição de subcampo, avança para o próximo subcampo do campo principal atual
                        const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                            (f) => f.tag === fieldToRepeatTag,
                        ) as DataField | undefined
                        if (currentFieldDef) {
                            const currentSubfieldIdx = currentFieldDef.subFieldDef.findIndex((sf) => sf.code === subfieldToRepeatCode)
                            const nextSubfieldIdx = currentSubfieldIdx + 1
                            if (nextSubfieldIdx < currentFieldDef.subFieldDef.length) {
                                state.askedSubfield = currentFieldDef.subFieldDef[nextSubfieldIdx].code
                            } else {
                                // Todos os subcampos para este campo principal estão concluídos, avança para o próximo campo principal
                                state.remainingFields = state.remainingFields.filter((f) => f !== fieldToRepeatTag)
                                delete state.askedField
                                delete state.askedSubfield
                                delete state.currentRepeatOccurrence // Limpa a ocorrência se o campo principal estiver concluído
                            }
                        }
                    } else {
                        // Se foi uma repetição de campo principal, avança para o próximo campo principal
                        state.remainingFields = state.remainingFields.filter((f) => f !== fieldToRepeatTag)
                        delete state.askedField
                        delete state.askedSubfield
                    }
                }
                // Após processar a confirmação, a userResponse foi consumida para esta iteração.
                // O loop 'while' abaixo determinará a próxima pergunta.
            }
            // 2. Processa resposta do utilizador a uma PERGUNTA de campo (se existir e NÃO for um comando especial)
            else if (state.askedField && userResponse !== undefined && userResponse !== null && !isSpecialCommand) {
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === state.askedField,
                )
                const isCurrentFieldRepeatable = currentFieldDef?.repeatable
                const trimmedResponse = typeof userResponse === "string" ? userResponse.trim() : ""

                // NOVO LOGS: Detalhes da resposta do utilizador
                console.log(
                    `Processing user response for ${state.askedField}${state.askedSubfield ? "$" + state.askedSubfield : ""}. Raw response: "${userResponse}"`,
                )
                console.log(`Trimmed response: "${trimmedResponse}"`)
                const shouldStoreValue = isValidFieldValue(trimmedResponse, currentFieldDef)
                console.log(`isValidFieldValue result for "${trimmedResponse}": ${shouldStoreValue}`)

                if (
                    currentFieldDef &&
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0
                ) {
                    // É um campo de dados com subcampos
                    const dataFieldDef = currentFieldDef as DataField
                    const currentSubfieldDef = dataFieldDef.subFieldDef.find((sf) => sf.code === state.askedSubfield)

                    // Garante que currentRepeatOccurrence existe para este campo
                    if (!state.currentRepeatOccurrence || state.currentRepeatOccurrence.tag !== state.askedField) {
                        state.currentRepeatOccurrence = { tag: state.askedField, subfields: {} }
                    }

                    if (shouldStoreValue) {
                        // Armazenar valores de subcampos repetíveis como arrays
                        if (currentSubfieldDef?.repeatable) {
                            if (!Array.isArray(state.currentRepeatOccurrence.subfields[state.askedSubfield!])) {
                                state.currentRepeatOccurrence.subfields[state.askedSubfield!] = []
                            }
                            ; (state.currentRepeatOccurrence.subfields[state.askedSubfield!] as any[]).push(trimmedResponse)
                        } else {
                            state.currentRepeatOccurrence.subfields[state.askedSubfield!] = trimmedResponse
                        }
                        console.log(`User response for ${state.askedField}$${state.askedSubfield}: ${trimmedResponse}`)
                    } else {
                        // Se o valor for inválido, para subcampos NÃO repetíveis, remove-o.
                        // Para subcampos repetíveis, simplesmente não adiciona o valor inválido.
                        console.log(
                            `Value for ${state.askedField}$${state.askedSubfield} is invalid. Current subfield repeatable: ${currentSubfieldDef?.repeatable}.`,
                        )
                        if (!currentSubfieldDef?.repeatable) {
                            delete (state.currentRepeatOccurrence.subfields as Record<string, any>)[state.askedSubfield!]
                            console.log(`Deleting subfield ${state.askedSubfield} from currentRepeatOccurrence.subfields.`)
                        } else {
                            console.log(`Not adding invalid value for repeatable subfield ${state.askedSubfield}.`)
                        }
                        console.log(`Subcampo ${state.askedField}$${state.askedSubfield} deixado em branco`)
                    }

                    // Se o subcampo é repetível E o utilizador forneceu um valor válido, pergunta pela confirmação de repetição
                    if (currentSubfieldDef?.repeatable && shouldStoreValue) {
                        const confirmPrompt = `Adicionou um valor para ${state.askedField}$${state.askedSubfield}. Deseja adicionar outro valor para este mesmo subcampo? (sim/não)`
                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            subfield: state.askedSubfield,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true, // Indica que estamos num ciclo de repetição para este subcampo
                                repeatConfirmation: { field: state.askedField, subfield: state.askedSubfield }, // Armazena o contexto de confirmação
                            },
                        } as CatalogResponse)
                    }

                    // Se não estiver a repetir este subcampo, avança para o próximo subcampo ou campo principal
                    const currentSubfieldIdx = dataFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                    const nextSubfieldIdx = currentSubfieldIdx + 1

                    if (nextSubfieldIdx < dataFieldDef.subFieldDef.length) {
                        state.askedSubfield = dataFieldDef.subFieldDef[nextSubfieldIdx].code
                        // state.repeatingField deve ser gerido pela lógica de repeatConfirmation, não aqui.
                    } else {
                        // Todos os subcampos para a ocorrência atual estão preenchidos
                        if (Object.keys(state.currentRepeatOccurrence?.subfields || {}).length > 0) {
                            // Verifica se o campo principal (state.askedField) é repetível
                            const currentFieldDefForRepeatCheck = [
                                ...state.currentTemplate.controlFields,
                                ...state.currentTemplate.dataFields,
                            ].find((f) => f.tag === state.askedField)

                            if (currentFieldDefForRepeatCheck?.repeatable) {
                                // Se o campo principal é repetível
                                if (!Array.isArray(state.filledFields[state.askedField])) {
                                    state.filledFields[state.askedField] = []
                                }
                                ; (state.filledFields[state.askedField] as any[]).push(state.currentRepeatOccurrence?.subfields)
                            } else {
                                // Se o campo principal NÃO é repetível, atribui diretamente o objeto de subcampos
                                state.filledFields[state.askedField] = state.currentRepeatOccurrence?.subfields
                            }
                            console.log(`Completed occurrence for ${state.askedField}:`, state.currentRepeatOccurrence?.subfields)
                        } else {
                            console.log(`Occurrence for ${state.askedField} has no valid subfields, not storing.`)
                            // Se não há subcampos válidos, e o campo não é repetível, garante que não é armazenado
                            const currentFieldDefForDeleteCheck = [
                                ...state.currentTemplate.controlFields,
                                ...state.currentTemplate.dataFields,
                            ].find((f) => f.tag === state.askedField)
                            if (currentFieldDefForDeleteCheck && !currentFieldDefForDeleteCheck.repeatable) {
                                delete state.filledFields[state.askedField]
                            }
                        }
                        delete state.currentRepeatOccurrence // Limpa para a próxima ocorrência

                        // Se o campo principal é repetível E acabamos de completar uma ocorrência, pergunta pela confirmação de repetição do campo principal
                        if (dataFieldDef.repeatable && Object.keys(state.filledFields[state.askedField] || {}).length > 0) {
                            const confirmPrompt = `Completou todos os subcampos de ${state.askedField}. Deseja adicionar outra ocorrência deste campo? (sim/não)`
                            return NextResponse.json({
                                type: "repeat-confirmation",
                                field: state.askedField,
                                question: confirmPrompt,
                                conversationState: {
                                    ...state,
                                    repeatingField: true, // Indica que estamos num ciclo de repetição para este campo principal
                                    repeatConfirmation: { field: state.askedField }, // Armazena o contexto de confirmação
                                },
                            } as CatalogResponse)
                        }

                        // Avança para o próximo campo principal
                        state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                        delete state.askedField
                        delete state.askedSubfield
                        state.repeatingField = false // Reinicia repeatingField se o campo principal estiver concluído
                        console.log(`All subfields for ${dataFieldDef.tag} filled. Remaining main fields:`, state.remainingFields)
                    }
                } else {
                    // Campo simples (sem subcampos)
                    if (shouldStoreValue) {
                        if (isCurrentFieldRepeatable) {
                            if (!Array.isArray(state.filledFields[state.askedField])) {
                                state.filledFields[state.askedField] = []
                            }
                            ; (state.filledFields[state.askedField] as any[]).push(trimmedResponse)
                            console.log(`Field ${currentFieldDef?.tag} added: ${trimmedResponse}`)
                        } else {
                            state.filledFields[state.askedField] = trimmedResponse
                            console.log(`Field ${currentFieldDef?.tag} filled: ${trimmedResponse}`)
                        }
                    } else {
                        console.log(
                            `Value for ${state.askedField} is invalid. Current field repeatable: ${isCurrentFieldRepeatable}.`,
                        )
                        if (!isCurrentFieldRepeatable) {
                            delete state.filledFields[state.askedField]
                            console.log(`Deleting field ${state.askedField} from filledFields.`)
                        } else {
                            console.log(`Not adding invalid value for repeatable field ${state.askedField}.`)
                        }
                        console.log(`Campo ${state.askedField} deixado em branco`)
                    }

                    // Se o campo simples é repetível E o utilizador forneceu um valor válido, pergunta pela confirmação de repetição
                    if (isCurrentFieldRepeatable && shouldStoreValue) {
                        const confirmPrompt = `Adicionou um valor para ${state.askedField}. Deseja adicionar outro valor para este mesmo campo? (sim/não)`
                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true, // Indica que estamos num ciclo de repetição para este campo
                                repeatConfirmation: { field: state.askedField }, // Armazena o contexto de confirmação
                            },
                        } as CatalogResponse)
                    }

                    state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                    delete state.askedField
                    delete state.askedSubfield
                    state.repeatingField = false // Reinicia repeatingField
                    console.log(`Field ${currentFieldDef?.tag} processed. Remaining main fields:`, state.remainingFields)
                }
                // NEW LOG: Log state.filledFields after user response processing
                console.log("State.filledFields after user response processing:", JSON.stringify(state.filledFields, null, 2))
            }

            // 3. Processa o próximo campo/subcampo a ser perguntado
            console.log("DEBUG: Entering field-filling loop determination.") // NOVO LOG
            console.log("DEBUG: state.askedField at loop start:", state.askedField) // NOVO LOG
            console.log("DEBUG: state.remainingFields at loop start:", state.remainingFields) // NOVO LOG
            while (state.remainingFields.length > 0 || (state.askedField && state.askedSubfield)) {
                const currentFieldTag = state.askedField || state.remainingFields[0]
                console.log("DEBUG: currentFieldTag determined as:", currentFieldTag) // NOVO LOG

                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === currentFieldTag,
                )

                if (!currentFieldDef) {
                    console.error(`Campo ${currentFieldTag} não encontrado na definição do template. A remover...`)
                    state.remainingFields.shift()
                    delete state.askedField
                    delete state.askedSubfield
                    state.repeatingField = false
                    delete state.currentRepeatOccurrence // Limpa se a definição do campo estiver incorreta
                    continue
                }

                const isDataFieldWithSubfields =
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0

                // Inicializa currentRepeatOccurrence se estiver a iniciar um novo campo de dados com subcampos
                // ou se estiver a iniciar uma nova ocorrência de um campo de dados repetível com subcampos
                if (
                    isDataFieldWithSubfields &&
                    (!state.currentRepeatOccurrence || state.currentRepeatOccurrence.tag !== currentFieldTag)
                ) {
                    state.currentRepeatOccurrence = { tag: currentFieldTag, subfields: {} }
                } else if (!isDataFieldWithSubfields) {
                    delete state.currentRepeatOccurrence // Limpa se não for um campo de dados com subcampos
                }

                let subfieldToAskCode: string | undefined
                let subfieldToAskDef: SubFieldDef | undefined

                if (isDataFieldWithSubfields) {
                    const dataFieldDef = currentFieldDef as DataField
                    if (state.askedField === currentFieldTag && state.askedSubfield) {
                        subfieldToAskCode = state.askedSubfield
                        subfieldToAskDef = dataFieldDef.subFieldDef.find((sf) => sf.code === subfieldToAskCode)
                    } else {
                        // Se estiver a iniciar uma nova ocorrência ou pela primeira vez para este campo
                        subfieldToAskCode = dataFieldDef.subFieldDef[0].code
                        subfieldToAskDef = dataFieldDef.subFieldDef[0]
                    }
                } else {
                    subfieldToAskCode = undefined
                }

                // Constrói a pergunta com indicação de obrigatoriedade
                const fieldTranslation = currentFieldDef.translations.find((t: Translation) => t.language === language)
                const fieldName = fieldTranslation?.name || currentFieldTag
                const tips = fieldTranslation?.tips ?? []
                const tipsText = tips.length > 0 ? `\n\n💡 Dicas:\n${tips.map((tip) => `• ${tip}`).join("\n")}` : ""
                let questionText = `Por favor, forneça: ${fieldName} [${currentFieldTag}]`
                let subfieldNameForResponse: string | null = null
                let subfieldTips: string[] = []

                if (subfieldToAskCode) {
                    let subfieldPart = `$${subfieldToAskCode}`
                    const subfieldTranslation = subfieldToAskDef?.translations?.find((t) => t.language === language)
                    if (subfieldTranslation?.label) {
                        subfieldPart = `${subfieldTranslation.label} (${subfieldPart})`
                        subfieldNameForResponse = subfieldTranslation.label
                    } else {
                        subfieldNameForResponse = subfieldToAskCode
                    }
                    // Adiciona indicação de obrigatoriedade
                    const mandatoryText = subfieldToAskDef?.mandatory ? " (obrigatório)" : " (opcional)"
                    questionText += ` - ${subfieldPart}${mandatoryText}`
                    subfieldTips = subfieldTranslation?.tips ?? []
                    if (!subfieldToAskDef?.mandatory) {
                        subfieldTips.unshift("Pode deixar em branco se não se aplicar")
                    }
                } else {
                    // Adiciona indicação de obrigatoriedade para campo simples
                    const mandatoryText = currentFieldDef.mandatory ? " (obrigatório)" : " (opcional)"
                    questionText += mandatoryText
                    if (!currentFieldDef.mandatory) {
                        tips.unshift("Pode deixar em branco se não se aplicar")
                    }
                }
                questionText += `.${tipsText}`

                console.log("=== ASKING USER FOR FIELD ===")
                console.log("Field:", currentFieldTag)
                console.log("Subfield:", subfieldToAskCode)
                console.log("Question:", questionText)

                return NextResponse.json({
                    type: "field-question",
                    field: currentFieldTag,
                    subfield: subfieldToAskCode,
                    subfieldName: subfieldNameForResponse || null,
                    question: questionText,
                    tips: tips,
                    subfieldTips: subfieldTips,
                    conversationState: {
                        ...state,
                        askedField: currentFieldTag,
                        askedSubfield: subfieldToAskCode,
                        repeatingField: state.repeatingField, // Preserva o estado de repeatingField
                        currentRepeatOccurrence: state.currentRepeatOccurrence, // Preserva a ocorrência atual
                    },
                } as CatalogResponse)
            }

            // Todos os campos preenchidos - avança para confirmação
            console.log("=== ALL FIELDS FILLED - ADVANCING TO CONFIRMATION ===")
            state.step = "confirmation"
            // LOG: Estado antes da etapa de confirmação
            console.log("State before confirmation step:", JSON.stringify(state, null, 2))
            return new Response(
                JSON.stringify({
                    type: "record-complete",
                    record: state.filledFields,
                    conversationState: state,
                    template: {
                        id: state.currentTemplate.id,
                        name: state.currentTemplate.name,
                    },
                } as CatalogResponse),
                {
                    status: 200,
                    headers: {
                        "Content-Type": "application/json",
                    },
                },
            )
        }

        // ================================
        // ETAPA 4: Confirmação e Gravação
        // ================================
        if (state.step === "confirmation") {
            console.log("=== INICIANDO CONFIRMAÇÃO E GRAVAÇÃO ===")
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
                // LOG: Campos preenchidos antes da conversão UNIMARC e salvamento
                console.log("Filled fields before UNIMARC conversion and saving:", JSON.stringify(state.filledFields, null, 2))

                // Converte campos para formato UNIMARC utilizando OpenAI
                console.log("Converting filled fields to UNIMARC text format...")
                const unimarcConversionPrompt = `Converta o seguinte objeto JSON de campos UNIMARC para o formato de texto UNIMARC.
Regras estritas:
1. Ignore completamente qualquer subcampo com valor "não", "nao", "n/a" ou string vazia.
2. Inclua apenas subcampos com valores válidos.
3. Campos obrigatórios sem valor válido devem ser representados com o código do subcampo e sem valor (ex: $a).
4. Nunca inclua o texto "não" como valor.
5. Se um CAMPO PRINCIPAL for repetível e tiver um array de objetos/valores, gere uma linha UNIMARC separada para cada item no array.
6. Se um SUBFIELD for repetível e tiver um array de valores, concatene-os na mesma linha UNIMARC, prefixando cada valor com o seu subcampo.

Exemplo de entrada com campos e subcampos repetíveis:
{
"001": "12345",
"200": [{"a": "Título1", "b": "Subtítulo1"}, {"a": "Título2", "b": "não"}], // Ignorar $b na segunda ocorrência
"102": {"a": ["ValorA1", "ValorA2"], "b": "ValorB"}, // Subcampo 'a' repetível
"008": ["ValorX", "ValorY"] // Campo '008' repetível
}

// NOVO EXEMPLO: Campo de dados NÃO repetível com subcampos NÃO repetíveis
Exemplo de entrada com campo de dados não repetível e subcampos:
{
"101": {"a": "por", "b": "eng"}, // Campo 101 não repetível, subcampos 'a' e 'b' não repetíveis
"200": {"a": "Título Único"}
}

Saída esperada para o NOVO EXEMPLO:
101  $apor$beng
200  $aTítulo Único

Saída esperada para o exemplo anterior:
001 12345
200  $aTítulo1$bSubtítulo1
200  $aTítulo2
102  $aValorA1$aValorA2$bValorB
008  ValorX
008  ValorY

Objeto JSON a converter:

Regra adicional para subcampos: Cada subcampo é representado por '$' seguido do código do subcampo e IMEDIATAMENTE pelo seu valor. Não há espaços entre o código do subcampo e o valor, nem '$' repetidos. Ex: {"d": "valor"} deve ser convertido para "$dvalor", NÃO "$d valor" ou "$d$valor".

${JSON.stringify(state.filledFields, null, 2)}`

                const unimarcCompletion = await openai.chat.completions.create({
                    model: "gpt-4",
                    messages: [
                        {
                            role: "system",
                            content:
                                "Você é um especialista em UNIMARC. Converta o JSON fornecido para o formato de texto UNIMARC EXATO, seguindo as regras estritas. Ignore valores inválidos como 'não' ou vazios.",
                        },
                        { role: "user", content: unimarcConversionPrompt },
                    ],
                    temperature: 0.1,
                    max_tokens: 1000,
                })

                const textUnimarc = unimarcCompletion.choices[0]?.message?.content?.trim() || ""
                console.log("Generated UNIMARC text:", textUnimarc)

                // Prepara dados para persistência
                const fieldsToSave: Array<{
                    tag: string
                    value: string | null
                    subfields?: Prisma.JsonValue
                    fieldType: FieldType
                    fieldName: string | null
                    subfieldNames?: Prisma.JsonValue
                }> = Object.entries(state.filledFields)
                    .flatMap(([tag, value]) => {
                        // Use flatMap para lidar com arrays
                        let fieldDef: FieldDefinition | undefined
                        if (state.currentTemplate) {
                            fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                                (f) => f.tag === tag,
                            )
                        }
                        const fieldType = fieldDef && "subFieldDef" in fieldDef ? FieldType.DATA : FieldType.CONTROL
                        const fieldName = fieldDef?.translations.find((t: Translation) => t.language === language)?.name || tag

                        if (Array.isArray(value)) {
                            // Lida com campos repetíveis (ocorrências completas ou valores simples)
                            return value
                                .map((item) => {
                                    let fieldValue: string | null = null
                                    let subfieldValues: Prisma.JsonValue | undefined
                                    let subfieldNames: Prisma.JsonValue | undefined

                                    if (fieldType === FieldType.DATA && typeof item === "object" && item !== null) {
                                        // Item é um objeto de subcampos para um campo de dados
                                        const filteredSubfields: Record<string, any> = {}
                                        for (const [subcode, subvalue] of Object.entries(item)) {
                                            if (isValidFieldValue(subvalue)) {
                                                filteredSubfields[subcode] = subvalue
                                            }
                                        }
                                        subfieldValues = filteredSubfields as Prisma.JsonValue
                                        const dataFieldDef = fieldDef as DataField
                                        subfieldNames = {}
                                        dataFieldDef.subFieldDef.forEach((sf) => {
                                            const sfTranslation = sf.translations?.find((t) => t.language === language)
                                                ; (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code
                                        })
                                    } else {
                                        // Item é um valor simples para um campo de controlo/dados simples
                                        fieldValue = isValidFieldValue(item) ? String(item) : null
                                    }

                                    return {
                                        tag,
                                        value: fieldValue,
                                        subfields: subfieldValues,
                                        fieldType,
                                        fieldName: fieldName || null,
                                        subfieldNames,
                                    }
                                })
                                .filter(
                                    (field) =>
                                        field.value !== null || (field.subfields && Object.keys(field.subfields as object).length > 0),
                                )
                        } else {
                            // Lida com campos não repetíveis (lógica atual)
                            let fieldValue: string | null = null
                            let subfieldValues: Prisma.JsonValue | undefined
                            let subfieldNames: Prisma.JsonValue | undefined

                            if (fieldType === FieldType.DATA && typeof value === "object" && value !== null) {
                                const filteredSubfields: Record<string, any> = {}
                                for (const [subcode, subvalue] of Object.entries(value)) {
                                    // MODIFICADO: Lida com subcampos que são arrays (repetíveis)
                                    if (Array.isArray(subvalue)) {
                                        const validSubvalues = subvalue.filter((sv) => isValidFieldValue(sv))
                                        if (validSubvalues.length > 0) {
                                            filteredSubfields[subcode] = validSubvalues
                                        }
                                    } else if (isValidFieldValue(subvalue)) {
                                        filteredSubfields[subcode] = subvalue
                                    }
                                }
                                subfieldValues = filteredSubfields as Prisma.JsonValue
                                const dataFieldDef = fieldDef as DataField
                                subfieldNames = {}
                                dataFieldDef.subFieldDef.forEach((sf) => {
                                    const sfTranslation = sf.translations?.find((t) => t.language === language)
                                        ; (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code
                                })
                            } else {
                                fieldValue = isValidFieldValue(value) ? String(value) : null
                            }

                            return [
                                {
                                    tag,
                                    value: fieldValue,
                                    subfields: subfieldValues,
                                    fieldType,
                                    fieldName: fieldName || null,
                                    subfieldNames,
                                },
                            ]
                        }
                    })
                    .filter(
                        (field) => field.value !== null || (field.subfields && Object.keys(field.subfields as object).length > 0),
                    )

                // LOG: Campos preparados para salvamento (fieldsToSave)
                console.log("Fields prepared for saving (fieldsToSave):", JSON.stringify(fieldsToSave, null, 2))

                // Persiste na base de dados
                console.log("Saving record to database...")
                const recordId = await databaseService.saveRecord({
                    templateId: state.currentTemplate.id,
                    templateName: state.currentTemplate.name,
                    templateDesc: `Registo catalogado automaticamente - ${new Date().toLocaleDateString()}`,
                    filledFields: state.filledFields,
                    template: state.currentTemplate,
                    textUnimarc,
                    fields: fieldsToSave.map((f) => ({
                        ...f,
                        value: f.value ?? null,
                        fieldName: f.fieldName ?? null,
                        subfields: f.subfields ?? null,
                        subfieldNames: f.subfieldNames ?? null,
                    })),
                })
                console.log("Record saved with ID:", recordId)

                return NextResponse.json({
                    type: "record-saved",
                    message: `Registo gravado com sucesso! ID: ${recordId}. ${state.autoFilledCount || 0} campos preenchidos automaticamente.`,
                    record: state.filledFields,
                    recordId,
                    textUnimarc,
                    conversationState: {
                        ...state,
                        step: "completed",
                    },
                } as CatalogResponse)
            } catch (error) {
                console.error("Erro ao gravar registo:", error)
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Erro ao gravar registo na base de dados.",
                        details: error instanceof Error ? error.message : "Erro desconhecido",
                    } as CatalogResponse,
                    { status: 500 },
                )
            }
        }

        console.log("=== FALLBACK - INVALID STATE ===")
        console.log("Current step:", state.step)
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
