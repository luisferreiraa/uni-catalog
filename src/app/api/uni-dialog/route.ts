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

function isValidFieldValue(value: any, fieldDef?: any): boolean {
    if (value === undefined || value === null) return false;

    if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length === 0) return false;
        if (["n/a", "não se aplica", "não", "nao", "-", "none", "null"].includes(trimmed.toLowerCase())) {
            return fieldDef?.mandatory; // Only accept if field is mandatory
        }
        return true;
    }

    if (typeof value === "object") {
        return Object.values(value).some(v =>
            typeof v === "string" && v.trim().length > 0 &&
            !["n/a", "não se aplica", "não", "nao", "-", "none", "null"].includes(v.toLowerCase())
        );
    }

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

                for (const [tag, value] of Object.entries(bulkFilledFields)) {
                    const fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                        (f) => f.tag === tag,
                    )

                    if (!fieldDef) {
                        console.warn(`Campo ${tag} não existe no template, ignorando`)
                        continue
                    }

                    if (isValidFieldValue(value, fieldDef)) {
                        if (typeof value === 'object') {
                            // Filter out invalid subfields
                            const filteredValue: Record<string, any> = {};
                            for (const [subcode, subvalue] of Object.entries(value)) {
                                if (isValidFieldValue(subvalue)) {
                                    filteredValue[subcode] = subvalue;
                                }
                            }
                            if (Object.keys(filteredValue).length > 0) {
                                validatedFields[tag] = filteredValue;
                                autoFilledCount++;
                            }
                        } else {
                            validatedFields[tag] = value;
                            autoFilledCount++;
                        }
                        console.log(`Campo ${tag} preenchido automaticamente:`, value)
                    } else {
                        console.log(`Campo ${tag} com valor inválido, será perguntado ao utilizador:`, value)
                    }
                }

                const allTemplateFields = fieldInference.getAllTemplateFields(state.currentTemplate)
                const remainingFields = allTemplateFields.filter((field) => !(field in validatedFields))

                console.log("All template fields:", allTemplateFields)
                console.log("Campos preenchidos automaticamente:", Object.keys(validatedFields))
                console.log("Campos restantes para perguntar:", remainingFields)

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

                const isRepeatingField = state.repeatingField === true;
                const trimmedResponse = typeof userResponse === 'string' ? userResponse.trim() : '';
                const shouldStoreValue = isValidFieldValue(trimmedResponse, currentFieldDef);

                if (
                    currentFieldDef &&
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0
                ) {
                    // É um campo de dados com subcampos
                    const dataFieldDef = currentFieldDef as DataField
                    const currentSubfieldDef = dataFieldDef.subFieldDef.find(
                        (sf) => sf.code === state.askedSubfield
                    )

                    if (!shouldStoreValue) {
                        // Remove o valor se existir
                        if (state.filledFields[state.askedField]?.[state.askedSubfield!] !== undefined) {
                            delete state.filledFields[state.askedField][state.askedSubfield!];
                        }
                        console.log(`Subcampo ${state.askedField}$${state.askedSubfield} deixado em branco`);
                    } else {
                        // Armazena o valor válido
                        if (!state.filledFields[state.askedField]) {
                            state.filledFields[state.askedField] = {};
                        }
                        state.filledFields[state.askedField][state.askedSubfield!] = trimmedResponse;
                        console.log(`User response for ${state.askedField}$${state.askedSubfield}: ${trimmedResponse}`);
                    }

                    // Verifica se o subcampo é repetível
                    if (currentSubfieldDef?.repeatable && !isRepeatingField && shouldStoreValue) {
                        const confirmPrompt = `Você adicionou um valor para ${state.askedField}$${state.askedSubfield}. Deseja adicionar outro valor para este mesmo subcampo? (sim/não)`

                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            subfield: state.askedSubfield,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true
                            }
                        } as CatalogResponse)
                    }

                    // Avança para o próximo subcampo ou campo
                    const currentSubfieldIdx = dataFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                    const nextSubfieldIdx = currentSubfieldIdx + 1

                    if (nextSubfieldIdx < dataFieldDef.subFieldDef.length) {
                        state.askedSubfield = dataFieldDef.subFieldDef[nextSubfieldIdx].code
                        state.repeatingField = false
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
                                    repeatingField: true
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
                    if (!shouldStoreValue) {
                        delete state.filledFields[state.askedField]
                        console.log(`Campo ${state.askedField} deixado em branco`);
                    } else {
                        state.filledFields[state.askedField] = trimmedResponse
                        console.log(`Field ${currentFieldDef?.tag} filled: ${trimmedResponse}`)
                    }

                    // Verifica se o campo é repetível
                    if (currentFieldDef?.repeatable && !isRepeatingField && shouldStoreValue) {
                        const confirmPrompt = `Você adicionou um valor para ${state.askedField}. Deseja adicionar outro valor para este mesmo campo? (sim/não)`

                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true
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
                    console.log(`User wants to repeat ${state.askedField}${state.askedSubfield ? '$' + state.askedSubfield : ''}`)
                    delete state.repeatConfirmation
                    state.repeatingField = true
                } else {
                    console.log(`User does not want to repeat ${state.askedField}${state.askedSubfield ? '$' + state.askedSubfield : ''}`)
                    delete state.repeatConfirmation
                    delete state.repeatingField

                    if (state.askedSubfield) {
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
                        repeatingField: false
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
Regras estritas:
1. Ignore completamente qualquer subcampo com valor "não", "nao", "n/a" ou string vazia
2. Inclua apenas subcampos com valores válidos
3. Campos obrigatórios sem valor válido devem ser representados com $a vazio
4. Nunca inclua o texto "não" como valor
5. Formato exato:
   - Campos de controle: "001 valor"
   - Campos de dados: "200  \$aTítulo\$bSubtítulo"

Exemplo:
{
  "001": "12345",
  "200": {"a": "Título", "b": "não"},  // Ignorar $b
  "101": {"a": "por", "c": "não"}       // Ignorar $c
}
Saída:
001 12345
200  \$aTítulo
101  \$apor

Objeto JSON a converter:
${JSON.stringify(state.filledFields, null, 2)}`

                const unimarcCompletion = await openai.chat.completions.create({
                    model: "gpt-4o",
                    messages: [
                        {
                            role: "system",
                            content: "Você é um especialista em UNIMARC. Converta o JSON fornecido para o formato de texto UNIMARC EXATO, seguindo as regras estritas. Ignore valores inválidos como 'não' ou vazios.",
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
                    tag: string;
                    value: string | null;
                    subfields?: Prisma.JsonValue;
                    fieldType: FieldType;
                    fieldName: string | null;
                    subfieldNames?: Prisma.JsonValue;
                }> = Object.entries(state.filledFields).map(([tag, value]) => {
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
                        // Filter out invalid subfields before saving
                        const filteredSubfields: Record<string, any> = {};
                        for (const [subcode, subvalue] of Object.entries(value)) {
                            if (isValidFieldValue(subvalue)) {
                                filteredSubfields[subcode] = subvalue;
                            }
                        }
                        subfieldValues = filteredSubfields as Prisma.JsonValue;
                        const dataFieldDef = fieldDef as DataField;
                        subfieldNames = {};
                        dataFieldDef.subFieldDef.forEach((sf) => {
                            const sfTranslation = sf.translations?.find((t) => t.language === language);
                            (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code;
                        });
                    } else {
                        fieldValue = isValidFieldValue(value) ? String(value) : null;
                    }

                    return {
                        tag,
                        value: fieldValue,
                        subfields: subfieldValues,
                        fieldType,
                        fieldName: fieldName || null,
                        subfieldNames,
                    }
                }).filter(field =>
                    // Remove campos vazios
                    field.value !== null ||
                    (field.subfields && Object.keys(field.subfields as object).length > 0)
                );

                console.log("Fields to save:", fieldsToSave);

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