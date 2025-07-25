export const runtime = 'nodejs'     // Especifica que esta rota deve rodar em Node.js

import { type NextRequest, NextResponse } from "next/server"
import OpenAI from "openai"
import { templateCache } from "@/lib/template-cache"
import { fieldInference } from "@/lib/field-heuristics"
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type { CatalogRequest, CatalogResponse, ConversationState, DataField, SubFieldDef } from "@/app/types/unimarc"
import { databaseService } from "@/lib/database"
import { FieldType, Prisma } from "@prisma/client"

// VANTAGEM OPENAI: 
// - A configuração é simples e permite integração rápida com modelos avançados
// - Redução do código complexo e específico
// - Menor necessidade de manutenção para novos casos
// - Melhor experiência de utilizador (menos campos manuais)
// - Flexibilidade para aceitar descrições naturais
// - Escalabilidade para novos tipos de conteúdo
// SEM OPENAI: Seria necessário criar parsers complexos ou usar API's especializadas de catalogação
// Configuração do cliente OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,     // API Key vinda das variáveis de ambiente
})

/**
 * API Route para processamento de catalogaçao UNIMARC
 * @param req NextRequest - Requisição recebida
 * @returns NextResponse - Resposta da API
 */
export async function POST(req: NextRequest) {
    try {
        // 1. Parse dos dados da requisição
        const { description, language = "pt", conversationState, userResponse }: CatalogRequest = await req.json()

        // Logs de debug
        console.log("=== DEBUG API CALL ===")
        console.log("Description:", description)
        console.log("UserResponse:", userResponse)
        console.log("ConversationState (received):", JSON.stringify(conversationState, null, 2))

        // 2. Carrega templates disponíveis
        const { templates } = await templateCache.getTemplates()

        // Validação de templates
        if (templates.length === 0) {
            return NextResponse.json(
                {
                    type: "error",
                    error: "Nenhum template disponível no momento.",
                } as CatalogResponse,
                { status: 503 },
            )
        }

        // 3. Inicializa ou clona o estado da conversa
        const state: ConversationState = conversationState
            ? JSON.parse(JSON.stringify(conversationState))     // Deep clone para evitar mutações
            : {
                step: "template-selection",
                filledFields: {},
                remainingFields: [],
                autoFilledCount: 0,
            }

        console.log("Current state (processed):", state.step)
        console.log("Filled fields (processed):", Object.keys(state.filledFields))
        console.log("Remaining fields (processed):", state.remainingFields)

        // 4. Lógica principal baseada no estado atual
        // ============================================
        // ETAPA 1: Seleção de Template
        // ============================================
        if (state.step === "template-selection") {
            // Prepara o prompt para seleção de template
            // VANTAGENS OPENAI: 
            // - O prompt é otimizado para entender descrições naturais e selecionar o template mais adequado
            // - Entende descrições como "CD dos Beatles lançado em 1968" e seleciona template correto
            // - Identifica implicitamente que é um registo musical
            // - Adapta-se a variações de linguagem
            // SEM OPENAI: 
            // - Seria necessário criar regras manuais complexas ou usar match por palavras-chave (menos preciso)
            // - Requer mapeamento manual exato (ex: "CD" -> "Template Musical")
            // - Dificuldade com descrições não padronizadas
            // - Necessidade de constantes atualizações nos mapeamentos
            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                "template-selection",
                description,
                { templates, language },
            )

            // Chama OpenAI para selecionar template
            // VANTAGENS OPENAI: Seleção inteligente considerando nuances na descrição
            // SEM OPENAI: Match simples por palavras-chave com alta taxa de erro
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

            // Fallback para template não encontrado
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

            // Processa campos do template selecionado
            const allTemplateFields = fieldInference.getAllTemplateFields(selectedTemplate)
            const autoFilled = fieldInference.inferFields(description, selectedTemplate)
            const remainingFields = allTemplateFields.filter((field) => !(field in autoFilled))

            console.log("All template fields:", allTemplateFields)
            console.log("Auto filled (initial):", autoFilled)
            console.log("Remaining after initial auto-fill:", remainingFields)

            // Retorna resposta com template selecionado
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

        // ===================================
        // ETAPA 2: Preenchimento de Campos
        // ===================================
        if (state.step === "field-filling") {
            // Valida template atual
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            // 2.1 Processa resposta do utilizador (se existir)
            if (state.askedField && userResponse !== undefined && userResponse !== null) {
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === state.askedField,
                )

                // Lógica para campos com subcampos
                if (
                    currentFieldDef &&
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0
                ) {
                    // É um campo de dados com subcampos
                    const dataFieldDef = currentFieldDef as DataField // Asserção de tipo

                    // Inicializa estrutura para subcampos se necessário
                    if (!state.filledFields[state.askedField]) {
                        state.filledFields[state.askedField] = {}
                    }

                    // Armazena resposta do utilizador
                    state.filledFields[state.askedField][state.askedSubfield!] = userResponse.trim()
                    console.log(`User response for ${state.askedField}$${state.askedSubfield}: ${userResponse}`)

                    // Verifica se há mais subcampos a preencher
                    const currentSubfieldIdx = dataFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                    const nextSubfieldIdx = currentSubfieldIdx + 1

                    if (nextSubfieldIdx < dataFieldDef.subFieldDef.length) {
                        // Prepara próximo subcampo
                        state.askedSubfield = dataFieldDef.subFieldDef[nextSubfieldIdx].code
                    } else {
                        // Finaliza campo principal quando todos os subcampos estão preenchidos
                        state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                        delete state.askedField
                        delete state.askedSubfield
                        console.log(`All subfields for ${dataFieldDef.tag} filled. Remaining main fields:`, state.remainingFields)
                    }
                } else {
                    // Lógica para campos simples (sem subcampos)
                    state.filledFields[state.askedField] = userResponse.trim()
                    state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                    delete state.askedField
                    delete state.askedSubfield
                    console.log(`Field ${currentFieldDef?.tag} filled. Remaining main fields:`, state.remainingFields)
                }
            }

            // 2.2 Processa próximo campo/ subcampo
            while (state.remainingFields.length > 0 || (state.askedField && state.askedSubfield)) {
                const currentFieldTag = state.askedField || state.remainingFields[0]
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === currentFieldTag,
                )

                // Valida campo atual
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

                // 2.2.1 Tenta preenchimento automático para campos simples
                if (!isDataFieldWithSubfields && fieldInference.canAutoFill(currentFieldTag)) {
                    // VANTAGEM OPENAI: 
                    // - Usa OpenAI para campos de dados complexos
                    // - Extrai automaticamente autores, título, datas de descrições livres
                    // -  Mantém consistência entre campos relacionados
                    // - Adapta-se a formatos variados de entrada
                    // SEM OPENAI: 
                    // - Requer entrada manual ou regras fixas para cada campo
                    // - Campos complexos exigiriam entrada manual
                    // - Valores padronizados exigiriam formulários complexos
                    // - Dificuldade em lidar com variações de formato
                    try {
                        console.log(`Tentando preencher automaticamente o campo: ${currentFieldTag}`)

                        let fieldValue = ""

                        // Lógica diferente para campos de controlo vs dados
                        const controlField = state.currentTemplate.controlFields.find((f) => f.tag === currentFieldTag)

                        if (controlField) {
                            fieldValue = fieldInference.generateControlFieldValue(currentFieldTag, description)

                        } else {
                            // Usa OpenAI para campos de dados complexos
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

                // 2.2.2 Prepara pergunta para o utilizador
                let subfieldToAskCode: string | undefined
                let subfieldToAskDef: SubFieldDef | undefined

                if (isDataFieldWithSubfields) {
                    const dataFieldDef = currentFieldDef as DataField

                    // Determina subcampo atual ou primeiro subcampo
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

                // Debug
                console.log("DEBUG: subfieldToAskCode:", subfieldToAskCode)
                console.log("DEBUG: subfieldToAskDef:", JSON.stringify(subfieldToAskDef, null, 2))
                console.log("DEBUG: subfieldToAskDef.translations:", JSON.stringify(subfieldToAskDef?.translations, null, 2))
                const subfieldTranslation = subfieldToAskDef?.translations?.find((t) => t.language === language)
                console.log("DEBUG: subfieldTranslation (found):", JSON.stringify(subfieldTranslation, null, 2))
                console.log("DEBUG: subfieldTranslation.label:", subfieldTranslation?.label)

                // Obtém traduções e dicas
                const fieldTranslation = currentFieldDef.translations.find((t) => t.language === language)
                const fieldName = fieldTranslation?.name || currentFieldTag
                const tips = fieldTranslation?.tips ?? []
                const tipsText = tips.length > 0 ? `\n\n💡 Dicas:\n${tips.map((tip) => `• ${tip}`).join("\n")}` : ""

                // Constrói o texto da pergunta
                let questionText = `Por favor, forneça: ${fieldName} [${currentFieldTag}]`
                let subfieldNameForResponse: string | null = null

                let subfieldTips: string[] = [] // Inicializa as dicas do subcampo

                // Adiciona informações de subcampo se necessário
                if (subfieldToAskCode) {
                    let subfieldPart = `$${subfieldToAskCode}`
                    const subfieldTranslation = subfieldToAskDef?.translations?.find((t) => t.language === language)
                    if (subfieldTranslation?.label) {
                        subfieldPart = `${subfieldTranslation.label} (${subfieldPart})`
                        subfieldNameForResponse = subfieldTranslation.label // Define o nome para a resposta
                    } else {
                        subfieldNameForResponse = subfieldToAskCode // Se não houver label, usa o código
                    }
                    questionText += ` - ${subfieldPart}`

                    // Dicas do subcampo
                    subfieldTips = subfieldTranslation?.tips ?? []
                }
                questionText += `.${tipsText}`

                // Retorna pergunta formatada
                return NextResponse.json({
                    type: "field-question",
                    field: currentFieldTag,
                    subfield: subfieldToAskCode, // Inclui o subcampo na resposta
                    subfieldName: subfieldNameForResponse || null,
                    question: questionText,
                    tips: tips, // Mantém as dicas como array para o frontend
                    subfieldTips: subfieldTips,
                    conversationState: {
                        ...state,
                        askedField: currentFieldTag,
                        askedSubfield: subfieldToAskCode,
                    },
                } as CatalogResponse)
            }

            // 2.3 Todos os campos preenchidos - avança para confirmação
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

        // ================================
        // ETAPA 3: Confirmação e Gravação
        // ================================
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
                // 3.1 Converte campos para formato UNIMARC utilizando OpenAI
                // VANTAGEM OPENAI: 
                // - Conversão precisa que segue padrões complexos do UNIMARC
                // - Aplica corretamente padrões complexos de formatação
                // - Lida com casos especiais automaticamente
                // - Gera saída padronizada sem necessidade de validação adicional
                // SEM OPENAI: 
                // - Necessário desenvolver parser manual com regras complexas
                // - Alta complexidade para lidar com todos os casos de borda
                // - Manutenção constante para novos templates/campos
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

                // 3.2 Prepara dados para persistência
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
                            const sfTranslation = sf.translations?.find((t) => t.language === language)

                                ; (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code
                        })
                    } else {
                        // É um campo de controlo ou um campo de dados sem subcampos explícitos
                        fieldValue = value ? String(value) : null;
                    }

                    return {
                        tag,
                        value: fieldValue,
                        subfields: subfieldValues,
                        fieldType,
                        fieldName: fieldName || null,
                        subfieldNames
                    };
                });

                // 3.3 Persiste na base de dados
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

                // 3.4 Retorna confirmação
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
