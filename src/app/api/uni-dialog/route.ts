export const runtime = 'nodejs'

import { type NextRequest, NextResponse } from "next/server"
import OpenAI from "openai"
import { templateCache } from "@/lib/template-cache"
import { fieldInference } from "@/lib/field-heuristics"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type { CatalogRequest, CatalogResponse, ConversationState, DataField, SubFieldDef } from "@/app/types/unimarc"
import { databaseService } from "@/lib/database"
import { FieldType, Prisma } from "@prisma/client"

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

/* function sanitizeTemplate(template: any) {
    return {
        id: template.id,
        name: template.name,
        controlFields: template.controlFields?.map((f: any) => ({
            tag: f.tag,
            translations: f.translations || [],
        })),
        dataFields: template.dataFields?.map((f: any) => ({
            tag: f.tag,
            translations: f.translations || [],
            subFieldDef: f.subFieldDef?.map((sf: any) => ({
                code: sf.code,
                name: sf.name,
            })) || [],
        })),
    }
} */

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
            }

        console.log("Current state (processed):", state.step)
        console.log("Filled fields (processed):", Object.keys(state.filledFields))
        console.log("Remaining fields (processed):", state.remainingFields)

        // ETAPA 1: Seleção de Template
        if (state.step === "template-selection") {
            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                "template-selection",
                description,
                { templates, language },
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
            const selectedTemplate = templates.find((t) => t.name === templateName)

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

            // 1. Processa a resposta do utilizador (se houver um campo/subcampo perguntado)
            if (state.askedField && userResponse !== undefined && userResponse !== null) {
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === state.askedField,
                )

                if (
                    currentFieldDef &&
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0
                ) {
                    // É um campo de dados com subcampos
                    const dataFieldDef = currentFieldDef as DataField // Asserção de tipo aqui
                    if (!state.filledFields[state.askedField]) {
                        state.filledFields[state.askedField] = {} // Inicializa como objeto para subcampos
                    }
                    state.filledFields[state.askedField][state.askedSubfield!] = userResponse.trim()
                    console.log(`User response for ${state.askedField}$${state.askedSubfield}: ${userResponse}`)

                    // Encontra o índice do subcampo atual
                    const currentSubfieldIdx = dataFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                    const nextSubfieldIdx = currentSubfieldIdx + 1

                    if (nextSubfieldIdx < dataFieldDef.subFieldDef.length) {
                        // Ainda há subcampos para este campo principal
                        state.askedSubfield = dataFieldDef.subFieldDef[nextSubfieldIdx].code
                        // Não remove o campo principal de remainingFields ainda
                        // Não limpa askedField, pois ainda estamos no mesmo campo principal
                    } else {
                        // Todos os subcampos para este campo principal foram preenchidos
                        state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                        delete state.askedField // Agora sim, limpa o campo principal
                        delete state.askedSubfield
                        console.log(`All subfields for ${dataFieldDef.tag} filled. Remaining main fields:`, state.remainingFields)
                    }
                } else {
                    // É um campo de controlo ou campo de dados sem subcampos explícitos (apenas $a)
                    state.filledFields[state.askedField] = userResponse.trim()
                    state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                    delete state.askedField
                    delete state.askedSubfield
                    console.log(`Field ${currentFieldDef?.tag} filled. Remaining main fields:`, state.remainingFields)
                }
            }

            // 2. Determina o próximo campo/subcampo a ser perguntado ou preenchido automaticamente
            // Loop para processar campos/subcampos até que uma pergunta seja gerada ou todos os campos sejam preenchidos
            while (state.remainingFields.length > 0 || (state.askedField && state.askedSubfield)) {
                const currentFieldTag = state.askedField || state.remainingFields[0]
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === currentFieldTag,
                )

                if (!currentFieldDef) {
                    console.error(`Campo ${currentFieldTag} não encontrado na definição do template. Removendo.`)
                    state.remainingFields.shift() // Remove o campo inválido
                    delete state.askedField
                    delete state.askedSubfield
                    continue // Tenta o próximo campo
                }

                const isDataFieldWithSubfields =
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0

                // Lógica de preenchimento automático para campos principais (não para subcampos individuais)
                // Se for um campo de dados com subcampos, NÃO tentamos auto-preencher, sempre perguntamos subcampo a subcampo.
                if (!isDataFieldWithSubfields && fieldInference.canAutoFill(currentFieldTag)) {
                    try {
                        console.log(`Tentando preencher automaticamente o campo: ${currentFieldTag}`)
                        let fieldValue = ""
                        const controlField = state.currentTemplate.controlFields.find((f) => f.tag === currentFieldTag)

                        if (controlField) {
                            fieldValue = fieldInference.generateControlFieldValue(currentFieldTag, description)
                        } else {
                            // Para campos de dados auto-preenchíveis (sem subcampos explícitos)
                            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                                "field-filling",
                                description,
                                {
                                    currentTemplate: state.currentTemplate,
                                    filledFields: state.filledFields,
                                    remainingFields: [currentFieldTag],
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

                        if (fieldValue && fieldValue.length > 0) {
                            state.filledFields[currentFieldTag] = fieldValue
                            state.remainingFields = state.remainingFields.filter((f) => f !== currentFieldTag)
                            state.autoFilledCount = (state.autoFilledCount || 0) + 1
                            console.log(`Campo ${currentFieldTag} preenchido automaticamente com: ${fieldValue}`)
                            // Retorna a resposta de auto-preenchimento. O frontend irá chamar novamente para o próximo passo.
                            return NextResponse.json({
                                type: "field-auto-filled",
                                field: currentFieldTag,
                                value: fieldValue,
                                conversationState: state,
                            } as CatalogResponse)
                        } else {
                            console.log(
                                `Preenchimento automático falhou para o campo ${currentFieldTag}, irá perguntar ao utilizador.`,
                            )
                        }
                    } catch (error) {
                        console.warn(`Erro no preenchimento automático do campo ${currentFieldTag}:`, error)
                    }
                }

                // Se não foi auto-preenchido ou é um campo de dados com subcampos, pergunta ao utilizador
                let subfieldToAskCode: string | undefined
                let subfieldToAskDef: SubFieldDef | undefined

                if (isDataFieldWithSubfields) {
                    const dataFieldDef = currentFieldDef as DataField // Asserção de tipo aqui
                    // Se já estamos a perguntar um subcampo para este campo principal
                    if (state.askedField === currentFieldTag && state.askedSubfield) {
                        subfieldToAskCode = state.askedSubfield // Continua com o subcampo atual
                        subfieldToAskDef = dataFieldDef.subFieldDef.find((sf) => sf.code === subfieldToAskCode)
                    } else {
                        // Começa a perguntar o primeiro subcampo deste campo principal
                        subfieldToAskCode = dataFieldDef.subFieldDef[0].code
                        subfieldToAskDef = dataFieldDef.subFieldDef[0]
                    }
                } else {
                    // Campo de controlo ou campo de dados sem subcampos explícitos
                    subfieldToAskCode = undefined
                }

                // Constrói a pergunta
                const fieldTranslation = currentFieldDef.translations.find((t) => t.language === language)
                const fieldName = fieldTranslation?.name || currentFieldTag
                // Correção: Acessar tips diretamente do fieldTranslation
                const tips = fieldTranslation?.tips ?? []
                const tipsText = tips.length > 0 ? `\n\n💡 Dicas:\n${tips.map((tip) => `• ${tip}`).join("\n")}` : ""

                let questionText = `Por favor, forneça: ${fieldName} [${currentFieldTag}]`
                if (subfieldToAskCode) {
                    questionText += ` - ${subfieldToAskDef?.name || subfieldToAskCode} ($${subfieldToAskCode})`
                }
                questionText += `.${tipsText}`

                return NextResponse.json({
                    type: "field-question",
                    field: currentFieldTag,
                    subfield: subfieldToAskCode, // Inclui o subcampo na resposta
                    subfieldName: subfieldToAskDef?.name || null,
                    question: questionText,
                    tips: tips, // Mantém as dicas como array para o frontend
                    conversationState: {
                        ...state,
                        askedField: currentFieldTag,
                        askedSubfield: subfieldToAskCode,
                    },
                } as CatalogResponse)
            }

            // Se o loop terminou, significa que todos os campos/subcampos foram preenchidos
            /* console.log("Todos os campos e subcampos preenchidos, avançando para confirmação.")
            state.step = "confirmation"
            return NextResponse.json({
                type: "record-complete",
                record: state.filledFields,
                conversationState: state,
                template: {
                    id: state.currentTemplate.id,
                    name: state.currentTemplate.name,
                },
            } as CatalogResponse) */

            console.log("Todos os campos e subcampos preenchidos, avançando para confirmação.")
            state.step = "confirmation"
            return new Response(JSON.stringify({
                type: "record-complete",
                record: state.filledFields,
                conversationState: state,
                template: {
                    id: state.currentTemplate.id,
                    name: state.currentTemplate.name,
                },
            } as CatalogResponse), {
                status: 200,
                headers: {
                    "Content-Type": "application/json"
                }
            })
        }

        // ETAPA 3: Confirmação e Gravação
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
                // PASSO NOVO: Converter filledFields para formato UNIMARC utilizando Open AI
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
                    model: "gpt-4o", // Usar um modelo mais capaz para esta conversão
                    messages: [
                        {
                            role: "system",
                            content:
                                "Você é um especialista em UNIMARC. Converta o JSON fornecido para o formato de texto UNIMARC EXATO, seguindo as regras estritas. Inclua TODOS os valores válidos. Não inclua introduções, conclusões ou qualquer texto que não seja o UNIMARC puro. Se um valor for inválido ou uma explicação, use um subcampo principal vazio ('$a').",
                        },
                        { role: "user", content: unimarcConversionPrompt },
                    ],
                    temperature: 0.1, // Manter baixa para resultados consistentes
                    max_tokens: 1000, // Aumentar para acomodar registos maiores
                })

                const textUnimarc = unimarcCompletion.choices[0]?.message?.content?.trim() || ""
                console.log("Generated UNIMARC text:", textUnimarc)

                // Lógica para preparar campos com nomes
                const fieldsToSave = Object.entries(state.filledFields).map(([tag, value]) => {
                    let fieldDef;
                    if (state.currentTemplate) {
                        fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                            (f) => f.tag === tag,
                        );
                    } else {
                        fieldDef = undefined;
                    }

                    // Corrige o fieldType para usar o enum FieldType
                    const fieldType = fieldDef && "subFieldDef" in fieldDef ? FieldType.DATA : FieldType.CONTROL;
                    const fieldName = fieldDef?.translations.find((t) => t.language === language)?.name || tag;

                    let subfieldNames: Prisma.JsonValue | undefined;
                    let fieldValue: string | null = null;
                    let subfieldValues: Prisma.JsonValue | undefined;

                    if (fieldType === FieldType.DATA && typeof value === "object" && value !== null) {
                        // É um campo de dados com subcampos
                        subfieldValues = value as Prisma.JsonValue;
                        const dataFieldDef = fieldDef as DataField;
                        subfieldNames = {};
                        dataFieldDef.subFieldDef.forEach((sf) => {
                            // Popula subfieldNames com código e nome
                            (subfieldNames as Record<string, string>)[sf.code] = sf.name;
                        });
                    } else {
                        // É um campo de controlo ou um campo de dados sem subcampos explícitos
                        fieldValue = value ? String(value) : null;
                    }

                    return {
                        tag,
                        value: fieldValue,
                        subfields: subfieldValues,
                        fieldType, // Agora usando o enum FieldType
                        fieldName: fieldName || null,
                        subfieldNames
                    };
                });

                // Persiste o registo completo na base de dados
                console.log("Saving record to database...")
                const recordId = await databaseService.saveRecord({
                    templateId: state.currentTemplate.id,
                    templateName: state.currentTemplate.name,
                    templateDesc: `Registro catalogado automaticamente - ${new Date().toLocaleDateString()}`,
                    filledFields: state.filledFields,
                    template: state.currentTemplate,
                    textUnimarc,
                    fields: fieldsToSave.map(f => ({
                        ...f,
                        // Garante que os valores undefined sejam convertidos para null
                        value: f.value ?? null,
                        fieldName: f.fieldName ?? null,
                        subfields: f.subfields ?? null,
                        subfieldNames: f.subfieldNames ?? null
                    }))
                });

                console.log("Record saved with ID:", recordId)

                // Retorna confirmação de sucesso
                return NextResponse.json({
                    type: "record-saved",
                    message: `Registro gravado com sucesso! ID: ${recordId}. ${state.autoFilledCount || 0} campos preenchidos automaticamente.`,
                    record: state.filledFields,
                    recordId,
                    textUnimarc, // INCLUA O textUnimarc NA RESPOSTA PARA O FRONTEND
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

        // Fallback para estado inválido
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
