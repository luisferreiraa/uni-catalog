import { type NextRequest, NextResponse } from "next/server"
import OpenAI from "openai"
import { templateCache } from "@/lib/template-cache"
import { fieldInference } from "@/lib/field-heuristics"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type { CatalogRequest, CatalogResponse, ConversationState, DataField, SubFieldDef } from "@/app/types/unimarc"
import { databaseService } from "@/lib/database"
import { FieldType, type Prisma } from "@prisma/client"

export const runtime = "nodejs"

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

function isValidFieldValue(value: any): boolean {
    if (!value) return false;
    if (typeof value === "string") return value.trim().length > 0 && !["n/a", "não se aplica"].includes(value.toLowerCase());
    if (typeof value === "object") return Object.values(value).some(v => typeof v === "string" && v.trim() !== "");
    return false;
}

export async function POST(req: NextRequest) {
    try {
        const { description, language = "pt", conversationState, userResponse }: CatalogRequest = await req.json()

        console.log("=== DEBUG API CALL ===")
        console.log("Description:", description)
        console.log("UserResponse:", userResponse)
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
            }

        console.log("Current state (processed):", state.step)
        console.log("Filled fields (processed):", Object.keys(state.filledFields))
        console.log("Remaining fields (processed):", state.remainingFields)

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

            // Avança para preenchimento automático em massa
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
                // Usa o prompt otimizado para preenchimento em massa
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

                // Tenta fazer parse do JSON retornado pela OpenAI
                let bulkFilledFields: Record<string, any> = {}
                try {
                    const cleanResponse = aiResponse.replace(/```json\n?|\n?```/g, "").trim()
                    bulkFilledFields = JSON.parse(cleanResponse)
                    console.log("Parsed bulk filled fields:", bulkFilledFields)
                } catch (parseError) {
                    console.warn("Erro ao fazer parse do JSON da OpenAI:", parseError)
                    console.warn("Resposta original:", aiResponse)
                }

                // Valida e limpa os campos preenchidos
                const validatedFields: Record<string, any> = {}
                let autoFilledCount = 0

                for (const [tag, value] of Object.entries(bulkFilledFields)) {
                    const fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                        (f) => f.tag === tag,
                    )

                    if (!fieldDef) {
                        console.warn(`Campo ${tag} não existe no template, ignorando`)
                        continue
                    }

                    if (isValidFieldValue(value)) {
                        validatedFields[tag] = value
                        autoFilledCount++
                        console.log(`Campo ${tag} preenchido automaticamente:`, value)
                    } else {
                        console.log(`Campo ${tag} com valor inválido, será perguntado ao utilizador:`, value)
                    }
                }

                // Determina quais campos ainda precisam ser preenchidos
                const allTemplateFields = fieldInference.getAllTemplateFields(state.currentTemplate)
                const remainingFields = allTemplateFields.filter((field) => !(field in validatedFields))

                console.log("All template fields:", allTemplateFields)
                console.log("Campos preenchidos automaticamente:", Object.keys(validatedFields))
                console.log("Campos restantes para perguntar:", remainingFields)

                // Atualiza o estado
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

            // Processa resposta do utilizador (se existir)
            if (state.askedField && userResponse !== undefined && userResponse !== null) {
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === state.askedField,
                )

                // Verifica se é um campo repetível que está sendo repetido
                const isRepeatingField = state.repeatingField === true;

                if (
                    currentFieldDef &&
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0
                ) {
                    // É um campo de dados com subcampos
                    const dataFieldDef = currentFieldDef as DataField

                    // Encontra a definição do subcampo atual
                    const currentSubfieldDef = dataFieldDef.subFieldDef.find(
                        (sf) => sf.code === state.askedSubfield
                    )

                    // Processa resposta para subcampo
                    const trimmedResponse = userResponse.trim()

                    // Se o campo não é obrigatório e a resposta está vazia, não armazena
                    if ((currentSubfieldDef?.mandatory !== true && trimmedResponse === "") ||
                        (currentSubfieldDef?.mandatory === true && !isValidFieldValue(trimmedResponse))) {
                        // Remove o valor se existir
                        if (state.filledFields[state.askedField]?.[state.askedSubfield!] !== undefined) {
                            delete state.filledFields[state.askedField][state.askedSubfield!]
                        }
                        console.log(`Subcampo ${state.askedField}$${state.askedSubfield} deixado em branco (não obrigatório)`)
                    } else {
                        // Armazena o valor válido
                        if (!state.filledFields[state.askedField]) {
                            state.filledFields[state.askedField] = {}
                        }
                        state.filledFields[state.askedField][state.askedSubfield!] = trimmedResponse
                        console.log(`User response for ${state.askedField}$${state.askedSubfield}: ${trimmedResponse}`)
                    }

                    // Verifica se o subcampo é repetível e se o usuário quer adicionar outro
                    if (currentSubfieldDef?.repeatable && !isRepeatingField && isValidFieldValue(trimmedResponse)) {
                        const confirmPrompt = `Você adicionou um valor para ${state.askedField}$${state.askedSubfield}. Deseja adicionar outro valor para este mesmo subcampo? (sim/não)`

                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            subfield: state.askedSubfield,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true // Marca que está no modo de repetição
                            }
                        } as CatalogResponse)
                    }

                    // Avança para o próximo subcampo ou campo
                    const currentSubfieldIdx = dataFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                    const nextSubfieldIdx = currentSubfieldIdx + 1

                    if (nextSubfieldIdx < dataFieldDef.subFieldDef.length) {
                        state.askedSubfield = dataFieldDef.subFieldDef[nextSubfieldIdx].code
                        state.repeatingField = false // Reseta o flag de repetição
                    } else {
                        // Verifica se o campo principal é repetível
                        if (dataFieldDef.repeatable && !isRepeatingField &&
                            Object.keys(state.filledFields[state.askedField] || {}).length > 0) {
                            const confirmPrompt = `Você completou todos os subcampos de ${state.askedField}. Deseja adicionar outra ocorrência deste campo? (sim/não)`

                            return NextResponse.json({
                                type: "repeat-confirmation",
                                field: state.askedField,
                                question: confirmPrompt,
                                conversationState: {
                                    ...state,
                                    repeatingField: true // Marca que está no modo de repetição
                                }
                            } as CatalogResponse)
                        }

                        // Remove o campo se não tiver subcampos válidos
                        if (Object.keys(state.filledFields[state.askedField] || {}).length === 0) {
                            delete state.filledFields[state.askedField]
                        }

                        state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                        delete state.askedField
                        delete state.askedSubfield
                        delete state.repeatingField
                        console.log(`All subfields for ${dataFieldDef.tag} filled. Remaining main fields:`, state.remainingFields)
                    }
                } else {
                    // Campo simples (sem subcampos)
                    const trimmedResponse = userResponse.trim()

                    // Se o campo não é obrigatório e a resposta está vazia, não armazena
                    if ((currentFieldDef?.mandatory !== true && trimmedResponse === "") ||
                        (currentFieldDef?.mandatory === true && !isValidFieldValue(trimmedResponse))) {
                        delete state.filledFields[state.askedField]
                        console.log(`Campo ${state.askedField} deixado em branco (não obrigatório)`)
                    } else {
                        // Armazena o valor válido
                        state.filledFields[state.askedField] = trimmedResponse
                        console.log(`Field ${currentFieldDef?.tag} filled: ${trimmedResponse}`)
                    }

                    // Verifica se o campo é repetível e se o usuário quer adicionar outro
                    if (currentFieldDef?.repeatable && !isRepeatingField && isValidFieldValue(trimmedResponse)) {
                        const confirmPrompt = `Você adicionou um valor para ${state.askedField}. Deseja adicionar outro valor para este mesmo campo? (sim/não)`

                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true // Marca que está no modo de repetição
                            }
                        } as CatalogResponse)
                    }

                    state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                    delete state.askedField
                    delete state.askedSubfield
                    delete state.repeatingField
                    console.log(`Field ${currentFieldDef?.tag} processed. Remaining main fields:`, state.remainingFields)
                }
            }

            // Processa confirmação de repetição (se existir)
            if (state.repeatConfirmation !== undefined && userResponse !== undefined && userResponse !== null) {
                const wantsToRepeat = userResponse.trim().toLowerCase() === 'sim'

                if (wantsToRepeat) {
                    // Mantém o mesmo campo/subcampo para nova entrada
                    console.log(`User wants to repeat ${state.askedField}${state.askedSubfield ? '$' + state.askedSubfield : ''}`)
                    delete state.repeatConfirmation
                    state.repeatingField = true
                } else {
                    // Prossegue para o próximo campo/subcampo
                    console.log(`User does not want to repeat ${state.askedField}${state.askedSubfield ? '$' + state.askedSubfield : ''}`)
                    delete state.repeatConfirmation
                    delete state.repeatingField

                    if (state.askedSubfield) {
                        // Avança para o próximo subcampo ou campo
                        const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                            (f) => f.tag === state.askedField,
                        ) as DataField | undefined

                        if (currentFieldDef) {
                            const currentSubfieldIdx = currentFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                            const nextSubfieldIdx = currentSubfieldIdx + 1

                            if (nextSubfieldIdx < currentFieldDef.subFieldDef.length) {
                                state.askedSubfield = currentFieldDef.subFieldDef[nextSubfieldIdx].code
                            } else {
                                state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                                delete state.askedField
                                delete state.askedSubfield
                            }
                        }
                    } else {
                        state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                        delete state.askedField
                    }
                }
            }

            // Processa próximo campo/subcampo
            while (state.remainingFields.length > 0 || (state.askedField && state.askedSubfield)) {
                const currentFieldTag = state.askedField || state.remainingFields[0]
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === currentFieldTag,
                )

                if (!currentFieldDef) {
                    console.error(`Campo ${currentFieldTag} não encontrado na definição do template. Removendo.`)
                    state.remainingFields.shift()
                    delete state.askedField
                    delete state.askedSubfield
                    continue
                }

                const isDataFieldWithSubfields =
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0

                // Prepara pergunta para o utilizador
                let subfieldToAskCode: string | undefined
                let subfieldToAskDef: SubFieldDef | undefined

                if (isDataFieldWithSubfields) {
                    const dataFieldDef = currentFieldDef as DataField

                    if (state.askedField === currentFieldTag && state.askedSubfield) {
                        subfieldToAskCode = state.askedSubfield
                        subfieldToAskDef = dataFieldDef.subFieldDef.find((sf) => sf.code === subfieldToAskCode)
                    } else {
                        subfieldToAskCode = dataFieldDef.subFieldDef[0].code
                        subfieldToAskDef = dataFieldDef.subFieldDef[0]
                    }
                } else {
                    subfieldToAskCode = undefined
                }

                // Constrói a pergunta com indicação de obrigatoriedade
                const fieldTranslation = currentFieldDef.translations.find((t) => t.language === language)
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
                        repeatingField: false // Reseta o flag ao perguntar um novo campo
                    },
                } as CatalogResponse)
            }

            // Todos os campos preenchidos - avança para confirmação
            console.log("=== ALL FIELDS FILLED - ADVANCING TO CONFIRMATION ===")
            state.step = "confirmation"

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
                // Converte campos para formato UNIMARC utilizando OpenAI
                console.log("Converting filled fields to UNIMARC text format...")
                const unimarcConversionPrompt = `Converta o seguinte objeto JSON de campos UNIMARC para o formato de texto UNIMARC.
Siga estas regras estritas para CADA campo:
1.  **Tag do Campo**: Comece com a tag do campo (ex: "001", "200").
2.  **Indicadores**: Para campos de dados (tags 1xx-9xx), adicione DOIS espaços para os indicadores. Se o JSON contiver indicadores específicos para esse campo, use-os. Caso contrário, use dois espaços em branco ('  ').
3.  **Subcampos**: Use o delimitador '$' seguido do código do subcampo (ex: '$a', '$b').
4.  **Valores Simples (para campos de controlo ou dados sem subcampos explícitos)**: Se o valor do campo no JSON for uma string simples (ex: "UNIMARC123"), inclua-o diretamente após a tag (e indicadores, se aplicável).
5.  **Valores Objeto (para campos de dados com subcampos)**: Se o valor do campo no JSON for um objeto (ex: {"a": "Memorial do convento", "e": "romance"}), cada chave do objeto é um código de subcampo e o seu valor é o conteúdo do subcampo. **Inclua TODOS os subcampos e seus valores, mesmo que um subcampo específico esteja vazio.**
6.  **Valores Vazios/Não Aplicáveis**: Se o valor de um campo no JSON for uma string VAZIA, NULA, ou uma string que representa "não aplicável" (ex: "N/A", "Não se aplica"), ou uma explicação (ex: "Para incluir o INTERNATIONAL ARTICLE NUMBER..."), então represente-o como um subcampo principal vazio (ex: '$a'). NÃO inclua o texto da explicação ou qualquer texto não-UNIMARC no output.
7.  **Nova Linha**: Cada campo DEVE estar numa nova linha.
8.  **Sem Texto Adicional**: NÃO inclua qualquer texto adicional, introduções, conclusões, ou qualquer coisa que não seja o formato UNIMARC puro.

**Exemplo de Conversão:**
JSON de entrada:
\`\`\`json
{
  "200": {
    "a": "Título Principal",
    "b": "Subtítulo",
    "f": "Autor"
  },
  "001": "ID_DO_REGISTRO",
  "101": {
    "a": "por",
    "c": "eng"
  }
}
\`\`\`
Saída UNIMARC esperada:
\`\`\`
001 ID_DO_REGISTRO
101  $apor$ceng
200  $aTítulo Principal$bSubtítulo$fAutor
\`\`\`

Objeto JSON a converter:
${JSON.stringify(state.filledFields, null, 2)}`

                const unimarcCompletion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "system",
                            content:
                                "Você é um especialista em UNIMARC. Converta o JSON fornecido para o formato de texto UNIMARC EXATO, seguindo as regras estritas. Inclua TODOS os valores válidos. Não inclua introduções, conclusões ou qualquer texto que não seja o UNIMARC puro. Se um valor for inválido ou uma explicação, use um subcampo principal vazio ('$a').",
                        },
                        { role: "user", content: unimarcConversionPrompt },
                    ],
                    temperature: 0.1,
                    max_tokens: 1000,
                })

                const textUnimarc = unimarcCompletion.choices[0]?.message?.content?.trim() || ""
                console.log("Generated UNIMARC text:", textUnimarc)

                // Prepara dados para persistência
                const fieldsToSave = Object.entries(state.filledFields).map(([tag, value]) => {
                    let fieldDef
                    if (state.currentTemplate) {
                        fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                            (f) => f.tag === tag,
                        )
                    } else {
                        fieldDef = undefined
                    }

                    const fieldType = fieldDef && "subFieldDef" in fieldDef ? FieldType.DATA : FieldType.CONTROL
                    const fieldName = fieldDef?.translations.find((t) => t.language === language)?.name || tag

                    let subfieldNames: Prisma.JsonValue | undefined
                    let fieldValue: string | null = null
                    let subfieldValues: Prisma.JsonValue | undefined

                    if (fieldType === FieldType.DATA && typeof value === "object" && value !== null) {
                        subfieldValues = value as Prisma.JsonValue
                        const dataFieldDef = fieldDef as DataField
                        subfieldNames = {}
                        dataFieldDef.subFieldDef.forEach((sf) => {
                            const sfTranslation = sf.translations?.find((t) => t.language === language)
                                ; (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code
                        })
                    } else {
                        fieldValue = value ? String(value) : null
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

                // Persiste na base de dados
                console.log("Saving record to database...")
                const recordId = await databaseService.saveRecord({
                    templateId: state.currentTemplate.id,
                    templateName: state.currentTemplate.name,
                    templateDesc: `Registro catalogado automaticamente - ${new Date().toLocaleDateString()}`,
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
                    message: `Registro gravado com sucesso! ID: ${recordId}. ${state.autoFilledCount || 0} campos preenchidos automaticamente.`,
                    record: state.filledFields,
                    recordId,
                    textUnimarc,
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