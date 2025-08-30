// src/app/api/uni-dialog/route.ts

// Next.js server types for API routes
import { type NextRequest, NextResponse } from "next/server"
// OpenAI SDK for AI completions
import OpenAI from "openai"
// Cache system for UNIMARC templates
import { templateCache } from "@/lib/template-cache"
// Logic for field inference and validation
import { fieldInference } from "@/lib/field-heuristics"
// Optimizes prompts for OpenAI API
import { promptOptimizer } from "@/lib/prompt-optimizer"
import type {
    CatalogRequest,
    CatalogResponse,
    ConversationState,
    DataField,
    SubFieldDef,
    Translation,
    FieldDefinition,
} from "@/app/types/unimarc"        // Type declarations for UNIMARC cataloging
// Database service for record persistence
import { databaseService } from "@/lib/database"
// Prisma ORM types
import { FieldType, type Prisma } from "@prisma/client"
// Field validation utility
import { isValidFieldValue } from "@/lib/is-valid-field-value"

// Configure runtime for Node.js (required for OpenAI usage)
export const runtime = "nodejs"

// Initialize OpenAI client with API key from environment variables
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
})

/**
 * POST endpoint handler for the cataloguing process
 * 
 * This is the main API endpoint that handles thee entire cataloguing workflow:
 * 1. Template selection - Uses AI to determine the appropriate UNIMARC template
 * 2. Bulk auto-filling of fields - Attemps to fill as many fields as possible automatically
 * 3. Individual field filling with user interaction - Interactive Q&A for remaining fields
 * 4. Confirmation and database storage - Finalizes and stores the catalog record
 * 
 * The endpoint maintains conversation state to handle multi-step interactions
 * 
 * @param req - NextRequest containing the request data with catalog information
 * @returns NextResponse with the cataloguing response, which varies based on the current step
 */
export async function POST(req: NextRequest) {
    try {
        // Extract data from the request body with type safety
        const {
            description,    // Textual description of the item to be cataloged
            language = "pt",    // Language preference for the interaction, defaults to pt
            conversationState,  // Current state of the cataloging conversation (for multi-step processes)
            userResponse,   // User's response to previous field questions (if applicable)
            fieldToEdit,    // Field identifier that user wants to edit (in review mode)
        }: CatalogRequest = await req.json()    // Parse JSON body with CatalogRequest type

        // Debug logs to track execution flow and help with troubleshooting
        console.log("=== DEBUG API CALL ===")
        console.log("Description:", description)        // Log the item description
        console.log("UserResponse (raw from payload):", userResponse)       // Log raw user response
        console.log("FieldToEdit (from payload):", fieldToEdit)     // Log which field user wants to edit
        console.log("ConversationState (received):", JSON.stringify(conversationState, null, 2))        // Log full conversation state

        // Get available templates from cache - these define the structure of UNIMARC records
        const { templates } = await templateCache.getTemplates()
        // Check if templates are available - critical for the cataloging process
        if (templates.length === 0) {
            // Return error response if no tempplates are available
            return NextResponse.json(
                {
                    type: "error",
                    error: "Nenhum template disponível no momento.",
                } as CatalogResponse,
                { status: 503 },        // HTTP 503 Service Unavailable
            )
        }

        // Initialize or clone conversation state
        // If conversationState is provided, create a deep clone to avoid mutation issues
        // Otherwise, initialize a new state with default values
        const state: ConversationState = conversationState
            ? JSON.parse(JSON.stringify(conversationState))     // Deep clone using serialization/deserialization
            : {
                step: "template-selection",     // Initial step in the workflow
                filledFields: {},       // Object to store successfully filled fields
                remainingFields: [],        // Array of field tags still needing completion
                autoFilledCount: 0,     // Counter for fields filled automatically by AI
                repeatingField: false,      // Flag indicating if we're in a repetition cycle for a field
                repeatConfirmation: undefined,      // Stores info about what needs repetition confirmation
                currentRepeatOccurrence: undefined,     // Tracks current occurrence for repeatable fields
            }

        // Processed state logs - helpful for debugging the current state of the process
        console.log("Current state (processed):", state.step)       // Current workflow
        console.log("Filled fields (processed):", Object.keys(state.filledFields))      // Fields already completed
        console.log("Remaining fields (processed):", state.remainingFields)     // Fields still to be completed

        // ============================================
        // Field Review/Edit Logic
        // ============================================
        // Handle special command to enter field review mode
        // This allows users to examine and potentially edit already-filled fields
        if (userResponse === "__REVIEW_FIELDS__") {
            console.log("=== ENTERING REVIEW FIELDS MODE ===")
            state.step = "review-fields"        // Transition to review mode
            console.log("DEBUG: State after entering review mode:", JSON.stringify(state, null, 2))

            // Return response showing all filled fields for user review
            return NextResponse.json({
                type: "review-fields-display",
                filledFields: state.filledFields,       // All completed fields
                conversationState: state,       // Upload state for client to persist
            } as CatalogResponse)
        }

        // Logic for editing a specific field identified by fieldToEdit parameter
        // This handles the case where the user wants to modify a previously filled field
        if (userResponse === "__EDIT_FIELD__" && fieldToEdit) {
            console.log(`=== PROCESSING EDIT FIELD COMMAND: ${fieldToEdit} ===`)
            console.log("DEBUG: State BEFORE edit processing:", JSON.stringify(state, null, 2))

            // Remove the field from filled fields so it can be re-filled
            delete state.filledFields[fieldToEdit]

            // Add the field back to remaining fields (at the beginning)
            // This ensures it will be the next field asked to the user
            state.remainingFields = state.remainingFields.filter((f) => f !== fieldToEdit)
            state.remainingFields.unshift(fieldToEdit)

            // Prepare state to ask for this field again
            state.askedField = fieldToEdit      // Field to be asked next
            state.askedSubfield = undefined     // Reset subfield pointer
            state.repeatingField = false        // Exit repetition cycle if active
            state.currentRepeatOccurrence = undefined       // Clear any occurrence data
            state.step = "field-filling"        // Return to field filling

            console.log(`DEBUG: Field ${fieldToEdit} removed from filledFields and added to remainingFields.`)
            console.log("DEBUG: State AFTER edit processing:", JSON.stringify(state, null, 2))
        }

        // Handle continuation from review mode
        // This transitions back to the appropriate step after reviewing fields
        if (userResponse === "__CONTINUE_FROM_REVIEW__") {
            console.log("=== CONTINUING FROM REVIEW MODE ===")
            // If no fields remain, move confirmation step
            // Otherwise, return to field filling to complete remaining fields
            if (state.remainingFields.length === 0) {
                state.step = "confirmation"
            } else {
                state.step = "field-filling"
            }
            console.log("DEBUG: State after continuing from review:", JSON.stringify(state, null, 2))
        }

        // ============================================
        // STEP 1: Template Selection
        // ============================================
        // This step uses AI to determine the most appropriate UNIMARC template
        // based on the item description
        if (state.step === "template-selection") {
            console.log("=== INICIANDO SELEÇÃO DE TEMPLATE ===")

            // Build optimized prompt for template selection
            // The prompt optimizer tailors the prompt based on the specific use case
            const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                "template-selection",       // Specific prompt type for template selection
                description,        // Item description to analyze
                { templates, language },        // Additional context: available templates and language
            )

            // Logging for debugging and monitoring
            console.log("Template selection prompt:", prompt)
            console.log(
                "Available templates:",
                templates.map((t) => t.name),       // Log just the template names for readability
            )

            // Call OpenAI to select the most appropriate template
            const completion = await openai.chat.completions.create({
                model,      // The AI model to use (determined by prompt optimizer)
                messages: [
                    { role: "system", content: systemMessage },     // System instructions
                    { role: "user", content: prompt },      // User query with item description
                ],
                temperature,        // Controls randomness (lower = more deterministic)
                max_tokens: maxTokens,      // Limit response length
            })

            // Process OpenAI response - extract the template name
            const templateName = completion.choices[0]?.message?.content?.trim()
            console.log("OpenAI selected template:", templateName)

            // Find the actual template object based on the name
            const selectedTemplate = templates.find((t) => t.name === templateName)
            console.log("Found template:", selectedTemplate ? selectedTemplate.name : "NOT FOUND")

            // If template is found, return options for manual selection
            // This is a fallback for when AI cannot confidently identify a template
            if (!selectedTemplate) {
                console.log("=== TEMPLATE NOT FOUND - RETURNING OPTIONS ===")
                return NextResponse.json(
                    {
                        type: "template-not-found",
                        error: "Template não identificado. Escolha manualmente:",
                        options: templates.map((t) => ({ name: t.name, id: t.id })),
                    } as CatalogResponse,
                    { status: 400 },        // HTTP 400 Bad Request
                )
            }

            // Prepare response with selected template and advance to the next step
            console.log("=== TEMPLATE SELECTED - ADVANCING TO BULK AUTO-FILL ===")
            console.log("Selected template ID:", selectedTemplate.id)
            console.log("Selected template name:", selectedTemplate.name)

            // Construct response with selected template and updated state
            const response = {
                type: "template-selected" as const,     // Response type for client handling
                conversationState: {
                    step: "bulk-auto-fill" as const,        // Next step in workflow
                    currentTemplate: selectedTemplate,      // The selected template
                    filledFields: {},       // Reset filled fields
                    remainingFields: [],        // Will be populated in next step
                    autoFilledCount: 0,     // Reset counter
                    repeatingField: false,      // Reset repetition flag
                    repeatConfirmation: undefined,      // Reset confirmation data
                    currentRepeatOccurrence: undefined,     // Reset occurance data
                },
                template: {
                    id: selectedTemplate.id,
                    name: selectedTemplate.name,
                    description: `Template selecionado: ${selectedTemplate.name}`,
                },
            } as CatalogResponse

            // Final logging before returning response
            console.log("=== RETURNING TEMPLATE SELECTION RESPONSE ===")
            console.log("Response type:", response.type)
            console.log("Next step:", response.conversationState?.step)

            return NextResponse.json(response)
        }

        // ============================================
        // STEP 2: Bulk Auto-Filling
        // ============================================
        // This step uses AI to automatically fill as many fields as possible
        // based on the item description and selected template
        if (state.step === "bulk-auto-fill") {
            console.log("=== INICIANDO PREENCHIMENTO AUTOMÁTICO EM MASSA ===")
            // Safety check - should always have a template at this point
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

            // Log template details for debugging
            console.log("Current template for bulk fill:", state.currentTemplate.name)
            console.log("Template has control fields:", state.currentTemplate.controlFields.length)
            console.log("Template has data fields:", state.currentTemplate.dataFields.length)

            try {
                // Build optimized prompt for bulk field filling
                const { prompt, systemMessage, maxTokens, temperature, model } = promptOptimizer.buildPrompt(
                    "bulk-field-filling",       // Specific prompt type for bulk filling
                    description,        // Item description
                    { currentTemplate: state.currentTemplate, language },       // Template context and language
                )

                // Logging for monitoring (truncated for readability)
                console.log("Bulk filling prompt:", prompt.substring(0, 200) + "...")
                console.log("Using model:", model)

                // Call OpenAI to generate field values in bulk
                const completion = await openai.chat.completions.create({
                    model,
                    messages: [
                        { role: "system", content: systemMessage },     // System instructions
                        { role: "user", content: prompt },      // Use query with template info
                    ],
                    temperature,
                    max_tokens: maxTokens,
                })

                // Extract and process AI response
                const aiResponse = completion.choices[0]?.message?.content?.trim() || ""
                console.log("AI Response for bulk filling:", aiResponse)

                // Parse the JSON response from AI
                let bulkFilledFields: Record<string, any> = {}
                try {
                    // Clean the response by removing markdown code block markers
                    const cleanResponse = aiResponse.replace(/```json\n?|\n?```/g, "").trim()
                    bulkFilledFields = JSON.parse(cleanResponse)        // Parse JSON
                    console.log("Parsed bulk filled fields:", bulkFilledFields)
                } catch (parseError) {
                    // Handle JSON parsing errors gracefully
                    console.warn("Erro ao fazer parse do JSON da OpenAI:", parseError)
                    console.warn("Resposta original:", aiResponse)
                }

                // Validate template fields for debugging validation process
                const validatedFields: Record<string, any> = {}
                let autoFilledCount = 0

                console.log(
                    "Template control fields for validation:",
                    state.currentTemplate.controlFields.map((f) => f.tag),
                )
                console.log(
                    "Template data fields for validation:",
                    state.currentTemplate.dataFields.map((f) => f.tag),
                )

                // Iterate through all AI-generated field values
                for (const [tag, value] of Object.entries(bulkFilledFields)) {
                    // Find the field definition in template
                    const fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                        (f) => f.tag === tag,
                    )
                    // Skip if field doesn't exist in template
                    if (!fieldDef) {
                        console.warn(`Campo ${tag} não existe no template, ignorando`)
                        continue
                    }

                    // Log validation details  for debugging
                    console.log(
                        `Validating field ${tag}. Value: ${JSON.stringify(value)}. Is valid: ${isValidFieldValue(value, fieldDef)}. Field is repeatable: ${fieldDef.repeatable}`,
                    )

                    // Process only valid field values
                    if (isValidFieldValue(value, fieldDef)) {
                        // Handle object values (typically data fields with subfields)
                        if (typeof value === "object" && !Array.isArray(value)) {
                            // Filter out invalid subfields
                            const filteredValue: Record<string, any> = {}
                            for (const [subcode, subvalue] of Object.entries(value)) {
                                if (isValidFieldValue(subvalue)) {
                                    filteredValue[subcode] = subvalue
                                }
                            }
                            // Only add if we have valid subfields
                            if (Object.keys(filteredValue).length > 0) {
                                if (fieldDef.repeatable) {
                                    // Initialize array if needed for repeatable fields
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
                            // Handle arrays for repeatable fields
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
                            // Simple field value (not an object or array)
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

                // Determine which fields still need to be filled
                const allTemplateFields = fieldInference.getAllTemplateFields(state.currentTemplate)

                // Log field information for debugging
                console.log("All template fields (from inference):", allTemplateFields)
                console.log("Validated fields after bulk fill:", Object.keys(validatedFields))
                const remainingFields = allTemplateFields.filter((field) => !(field in validatedFields))
                console.log("Remaining fields after bulk fill (before state update):", remainingFields)

                // Update state with results of bulk filling
                state.filledFields = validatedFields
                state.remainingFields = remainingFields
                state.autoFilledCount = autoFilledCount
                state.step = "field-filling"        // Advance to the next step

                // Return response based on whether any fields were auto-filled
                if (autoFilledCount > 0) {
                    console.log("=== RETURNING BULK AUTO-FILLED RESPONSE ===")
                    return NextResponse.json({
                        type: "bulk-auto-filled",
                        message: `${autoFilledCount} campos preenchidos automaticamente`,
                        filledFields: validatedFields,
                        conversationState: state,
                    } as CatalogResponse)
                } else {
                    // If no fields were auto-filled, continue to manual filling
                    console.log("=== NO FIELDS AUTO-FILLED, CONTINUING TO MANUAL FILLING ===")
                    state.step = "field-filling"
                }
            } catch (error) {
                // Error handling for bulk fill process
                console.error("Erro no preenchimento automático em massa:", error)
                // On error, get all template fields and proceed with manual filling
                const allTemplateFields = fieldInference.getAllTemplateFields(state.currentTemplate)
                state.remainingFields = allTemplateFields
                state.step = "field-filling"
            }
        }

        // ===================================
        // STEP 3: Individual Field Filling
        // ===================================
        // This step handles interactive field-by-field completion with the user
        if (state.step === "field-filling") {
            console.log("=== INICIANDO PREENCHIMENTO INDIVIDUAL DE CAMPOS ===")
            // Safety check - should always have a template at this point
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado.",
                    } as CatalogResponse,
                    { status: 400 },
                )
            }

            // Log current state for debugging
            // These logs help track the field filling process and troubleshoot issues
            console.log("Remaining fields to fill:", state.remainingFields)     // Shows which field still needs user input
            console.log("Currently asked field:", state.askedField)     // Indicates which field is currently being processed
            console.log("User response received:", userResponse)        // Displays the raw response from the user

            // Check if userResponse is a speecial command that has already been handled
            // This prevents re-processing commands that were handled by previous logic sessions
            // The commands are system commands
            // rather than actual field values, so they need special handling
            const isSpecialCommand = ["__EDIT_FIELD__", "__CONTINUE_FROM_REVIEW__"].includes(userResponse || "")

            // 1. Process user response to a REPETITION confirmation (if exists)
            // This handles when user confirms or denies whether to repeat a field/subfield
            // The repeatConfirmation state property indicates we're waiting for a yes/no answer
            // about whether to add another ocurrence of a field or subfield
            if (state.repeatConfirmation && userResponse !== undefined && userResponse !== null) {
                // Determine if user wants to repeat based on their responses
                // Converts response to lowercase and checks for 'sim'
                const wantsToRepeat = userResponse.trim().toLowerCase() === "sim"

                // Extract information about what needs to be repeated from the confirmation state
                const fieldToRepeatTag = state.repeatConfirmation.field     // The field tag to repeat
                const subfieldToRepeatCode = state.repeatConfirmation.subfield      // The subfield  code if applicable

                // Clear the repeatingField flag based on user's choice
                delete state.repeatConfirmation

                // Update the repeatingField request based on user's choice
                // This flag will influence how the field processing logic behaves
                state.repeatingField = wantsToRepeat

                if (wantsToRepeat) {
                    // User wants to add another occurrence of the field/subfiield
                    console.log(
                        `User wants to repeat ${fieldToRepeatTag}${subfieldToRepeatCode ? "$" + subfieldToRepeatCode : ""}`,
                    )

                    // Set the askedField/askedSubField back to what is being repeated
                    // This ensures thhe system ask for the same field/subfield again
                    state.askedField = fieldToRepeatTag
                    state.askedSubfield = subfieldToRepeatCode

                    // Don't return here. The 'while' loop below will generate the question
                    // for the repeated field/subField, allowing the process to continue naturally
                } else {
                    // User does NOT want to repeat the field/subField
                    console.log(
                        `User does not want to repeat ${fieldToRepeatTag}${subfieldToRepeatCode ? "$" + subfieldToRepeatCode : ""}`,
                    )

                    // Since user said NO, advance to the next logial field/subfield
                    if (subfieldToRepeatCode) {
                        // This was a subfield repetition confirmation
                        // Find the field definition to understand its structure
                        const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                            (f) => f.tag === fieldToRepeatTag,
                        ) as DataField | undefined

                        if (currentFieldDef) {
                            // Find the position of the current subfield in the field definition
                            const currentSubfieldIdx = currentFieldDef.subFieldDef.findIndex((sf) => sf.code === subfieldToRepeatCode)
                            const nextSubfieldIdx = currentSubfieldIdx + 1

                            if (nextSubfieldIdx < currentFieldDef.subFieldDef.length) {
                                // There are more subfields to process for this main field
                                // Move to the next subfield in sequence
                                state.askedSubfield = currentFieldDef.subFieldDef[nextSubfieldIdx].code
                            } else {
                                // All subfields for this main field are completed
                                // Remove the field from remaining fields and clean up state
                                state.remainingFields = state.remainingFields.filter((f) => f !== fieldToRepeatTag)
                                delete state.askedField
                                delete state.askedSubfield
                                delete state.currentRepeatOccurrence // Clear the occurrence since the main field is completed
                            }
                        }
                    } else {
                        // This was a main field repetition confirmation (not a subfield)
                        // Remove the field from remaining fields and clean up state
                        state.remainingFields = state.remainingFields.filter((f) => f !== fieldToRepeatTag)
                        delete state.askedField
                        delete state.askedSubfield
                    }
                }
                // After processing the confirmation, the userResponse has been consumed for this iteration
                // The 'while' loop below will determine the next question based on the updated state
            }
            // 2. Process user response to FIELD QUESTION (if it exists and is NOT a special command)
            // This section handles normal user responses to field value questions
            else if (state.askedField && userResponse !== undefined && userResponse !== null && !isSpecialCommand) {
                // Find the field definition for the currently asked fiield
                // Search through  both control fields and data fields in the current template
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === state.askedField,
                )

                // Check if the current field is repeatable (can have multiple values)
                const isCurrentFieldRepeatable = currentFieldDef?.repeatable

                // Clean the user response by trimming whitespace if it's a string
                // This ensures consistent processing of user input
                const trimmedResponse = typeof userResponse === "string" ? userResponse.trim() : ""

                // Detailed logging to help with debugging and understanding user interactions
                console.log(
                    `Processing user response for ${state.askedField}${state.askedSubfield ? "$" + state.askedSubfield : ""}. Raw response: "${userResponse}"`,
                )
                console.log(`Trimmed response: "${trimmedResponse}"`)

                // Validate the user response using the field validation utility
                // This checks if the value is appropriate for this field type
                const shouldStoreValue = isValidFieldValue(trimmedResponse, currentFieldDef)
                console.log(`isValidFieldValue result for "${trimmedResponse}": ${shouldStoreValue}`)

                // Check if this is a data field with subfields (as opposed to a simple control field)
                // Data fields havve subFieldDef property with an array of subfield definitions
                if (
                    currentFieldDef &&
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0
                ) {
                    // It's a data field with subfields
                    // Cast to DataField type for TypeScript type safety
                    const dataFieldDef = currentFieldDef as DataField

                    // Find the definition of the current subfield being processed
                    const currentSubfieldDef = dataFieldDef.subFieldDef.find((sf) => sf.code === state.askedSubfield)

                    // Ensure currentRepeatOccurance exists for this field
                    // This object tracks the current occurrence of a repeatable field being filled
                    if (!state.currentRepeatOccurrence || state.currentRepeatOccurrence.tag !== state.askedField) {
                        state.currentRepeatOccurrence = { tag: state.askedField, subfields: {} }
                    }

                    // Process valid field values
                    if (shouldStoreValue) {
                        // Store values of repeatable subfields as arrays
                        // This allows multiple values for the same subfield code
                        if (currentSubfieldDef?.repeatable) {
                            // Initialize the array if it doesn' exist
                            if (!Array.isArray(state.currentRepeatOccurrence.subfields[state.askedSubfield!])) {
                                state.currentRepeatOccurrence.subfields[state.askedSubfield!] = []
                            }
                            // Add the value to the array for repeatable subfields
                            ; (state.currentRepeatOccurrence.subfields[state.askedSubfield!] as any[]).push(trimmedResponse)
                        } else {
                            // For non-repeatable subfields, store the value directly
                            state.currentRepeatOccurrence.subfields[state.askedSubfield!] = trimmedResponse
                        }
                        console.log(`User response for ${state.askedField}$${state.askedSubfield}: ${trimmedResponse}`)
                    } else {
                        // If the value is invalid, handle it appropriately based on subfield type
                        console.log(
                            `Value for ${state.askedField}$${state.askedSubfield} is invalid. Current subfield repeatable: ${currentSubfieldDef?.repeatable}.`,
                        )

                        // For NON-repeatable subfields, remove any existing value
                        if (!currentSubfieldDef?.repeatable) {
                            delete (state.currentRepeatOccurrence.subfields as Record<string, any>)[state.askedSubfield!]
                            console.log(`Deleting subfield ${state.askedSubfield} from currentRepeatOccurrence.subfields.`)
                        } else {
                            // For repeatable subfields, simply don't add the invalid value
                            console.log(`Not adding invalid value for repeatable subfield ${state.askedSubfield}.`)
                        }
                        console.log(`Subcampo ${state.askedField}$${state.askedSubfield} deixado em branco`)
                    }

                    // If the subfield is repeatable AND the user provided a valid value
                    // ask for repetition permission to allow adding another value
                    if (currentSubfieldDef?.repeatable && shouldStoreValue) {
                        const confirmPrompt = `Adicionou um valor para ${state.askedField}$${state.askedSubfield}. Deseja adicionar outro valor para este mesmo subcampo? (sim/não)`

                        // Return a responsee that asks for repetition confirmation
                        // This pauses the field processing until user responds
                        return NextResponse.json({
                            type: "repeat-confirmation",
                            field: state.askedField,
                            subfield: state.askedSubfield,
                            question: confirmPrompt,
                            conversationState: {
                                ...state,
                                repeatingField: true, // Indicates we're in a repetition cycle for this subfield
                                repeatConfirmation: { field: state.askedField, subfield: state.askedSubfield }, // Stores the confirmation context
                            },
                        } as CatalogResponse)
                    }

                    // If not repeating this subfield, advance to the next subfield or main field
                    // Find the current position in the subfield sequence
                    const currentSubfieldIdx = dataFieldDef.subFieldDef.findIndex((sf) => sf.code === state.askedSubfield)
                    const nextSubfieldIdx = currentSubfieldIdx + 1

                    if (nextSubfieldIdx < dataFieldDef.subFieldDef.length) {
                        // There are more subfields to process for this field
                        // Move to the next subfield in the sequence
                        state.askedSubfield = dataFieldDef.subFieldDef[nextSubfieldIdx].code
                    } else {
                        // All subfields for the current occurrence are filled
                        // Check if we have any valid subfield values to store
                        if (Object.keys(state.currentRepeatOccurrence?.subfields || {}).length > 0) {
                            // Check if the main field (state.askedField) is repeatable
                            const currentFieldDefForRepeatCheck = [
                                ...state.currentTemplate.controlFields,
                                ...state.currentTemplate.dataFields,
                            ].find((f) => f.tag === state.askedField)

                            if (currentFieldDefForRepeatCheck?.repeatable) {
                                // If the main field is repeatable, add to an array of occurrences
                                if (!Array.isArray(state.filledFields[state.askedField])) {
                                    state.filledFields[state.askedField] = []
                                }
                                ; (state.filledFields[state.askedField] as any[]).push(state.currentRepeatOccurrence?.subfields)
                            } else {
                                // If the main field is NOT repeatable, assign the subfields obkect directly
                                state.filledFields[state.askedField] = state.currentRepeatOccurrence?.subfields
                            }
                            console.log(`Completed occurrence for ${state.askedField}:`, state.currentRepeatOccurrence?.subfields)
                        } else {
                            // No valid subfields were provided for this occurrence
                            console.log(`Occurrence for ${state.askedField} has no valid subfields, not storing.`)

                            // If there are no valid subfields, and the field is not repeatable,
                            // ensure it's not stored in the filled fields
                            const currentFieldDefForDeleteCheck = [
                                ...state.currentTemplate.controlFields,
                                ...state.currentTemplate.dataFields,
                            ].find((f) => f.tag === state.askedField)
                            if (currentFieldDefForDeleteCheck && !currentFieldDefForDeleteCheck.repeatable) {
                                delete state.filledFields[state.askedField]
                            }
                        }

                        // Clear the current occurrence for the next potential occurrence
                        delete state.currentRepeatOccurrence

                        // If the main field is repeatable AND we just completed a valid occurrence
                        // ask for repetition confirmation to allow adding another occurrence
                        if (dataFieldDef.repeatable && Object.keys(state.filledFields[state.askedField] || {}).length > 0) {
                            const confirmPrompt = `Completou todos os subcampos de ${state.askedField}. Deseja adicionar outra ocorrência deste campo? (sim/não)`

                            // Return a response that asks for field repetition confirmation
                            return NextResponse.json({
                                type: "repeat-confirmation",
                                field: state.askedField,
                                question: confirmPrompt,
                                conversationState: {
                                    ...state,
                                    repeatingField: true, // Indicates  we're in a repetition cycle for this main field
                                    repeatConfirmation: { field: state.askedField }, // Stores the confirmation context
                                },
                            } as CatalogResponse)
                        }

                        // Advance to the next main field
                        // Remove the current field from the remaining fields list since it's now completed
                        state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)

                        // Clean up the state by removing field-specific tracking properties
                        delete state.askedField     // Clear the currently asked field
                        delete state.askedSubfield      // Clear the currently asked subfield

                        // Reset the repeatingField flag since the main field is now completed
                        // This ensures we're enot in a repetition cycle for the next field
                        state.repeatingField = false

                        // Log completion of all subfields for this field and show remaining fields
                        console.log(`All subfields for ${dataFieldDef.tag} filled. Remaining main fields:`, state.remainingFields)
                    }
                } else {
                    // Simple field (without subfields)
                    // This branch handles fields that don't have subfield structures

                    // Process valid field values
                    if (shouldStoreValue) {
                        // Handle repeatable simple fields (can have multiple values)
                        if (isCurrentFieldRepeatable) {
                            // Initialize array if it doesn't exist for this repeatable field
                            if (!Array.isArray(state.filledFields[state.askedField])) {
                                state.filledFields[state.askedField] = []
                            }
                            // Add the value to the array for repeatable fields
                            ; (state.filledFields[state.askedField] as any[]).push(trimmedResponse)
                            console.log(`Field ${currentFieldDef?.tag} added: ${trimmedResponse}`)
                        } else {
                            // For non-repeatable fields, store the value directly
                            state.filledFields[state.askedField] = trimmedResponse
                            console.log(`Field ${currentFieldDef?.tag} filled: ${trimmedResponse}`)
                        }
                    } else {
                        // Handle invalid field values
                        console.log(
                            `Value for ${state.askedField} is invalid. Current field repeatable: ${isCurrentFieldRepeatable}.`,
                        )

                        // For non-repeatable fields with invalid values, remove the field entirely
                        if (!isCurrentFieldRepeatable) {
                            delete state.filledFields[state.askedField]
                            console.log(`Deleting field ${state.askedField} from filledFields.`)
                        } else {
                            // For repeatable fields, just don't add the invalid value
                            console.log(`Not adding invalid value for repeatable field ${state.askedField}.`)
                        }
                        console.log(`Campo ${state.askedField} deixado em branco`)
                    }

                    // If the simple field is repeatable AND the user provided a valid value,
                    // ask for repetition confirmation to alloww adding another value
                    if (isCurrentFieldRepeatable && shouldStoreValue) {
                        const confirmPrompt = `Adicionou um valor para ${state.askedField}. Deseja adicionar outro valor para este mesmo campo? (sim/não)`

                        // Reteurn a response that asks for field repetition confirmation
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

                    // After processing the field (whether valid or invalid)
                    // remove it from the remaining fields and clean up state
                    state.remainingFields = state.remainingFields.filter((f) => f !== state.askedField)
                    delete state.askedField
                    delete state.askedSubfield
                    state.repeatingField = false // Reset repeatingFiield flag

                    // Log completion of this field processing
                    console.log(`Field ${currentFieldDef?.tag} processed. Remaining main fields:`, state.remainingFields)
                }

                // Log state.filledFields user response processing
                console.log("State.filledFields after user response processing:", JSON.stringify(state.filledFields, null, 2))
            }

            // 3. Process the next field/subfield to be asked
            // This section determines what question to ask the user next
            console.log("DEBUG: Entering field-filling loop determination.")
            console.log("DEBUG: state.askedField at loop start:", state.askedField)
            console.log("DEBUG: state.remainingFields at loop start:", state.remainingFields)

            // Loop through remaining fields or continue with current field/subvield
            // This while loop  ensures we keep asking questions until all fields are completed
            while (state.remainingFields.length > 0 || (state.askedField && state.askedSubfield)) {

                // Determine which field to process next
                // If we're in the middle of a field (askedField exists), use that
                // Otherwise, take the first field from remainingFields
                const currentFieldTag = state.askedField || state.remainingFields[0]
                console.log("DEBUG: currentFieldTag determined as:", currentFieldTag)

                // Find the field definition for the current field
                const currentFieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                    (f) => f.tag === currentFieldTag,
                )

                // Safeetey check: if field definition doesn't exist, skip and continue
                if (!currentFieldDef) {
                    console.error(`Campo ${currentFieldTag} não encontrado na definição do template. A remover...`)
                    state.remainingFields.shift()       // Remove from remaining fields
                    delete state.askedField
                    delete state.askedSubfield
                    state.repeatingField = false
                    delete state.currentRepeatOccurrence // Clear if field definition is incorrect

                    continue        // Skip to next iteration
                }

                // Check if this is a data field with subfields
                // Data fields have subFieldDef property with subfield definitions
                const isDataFieldWithSubfields =
                    "subFieldDef" in currentFieldDef &&
                    Array.isArray((currentFieldDef as DataField).subFieldDef) &&
                    (currentFieldDef as DataField).subFieldDef.length > 0

                // Initialize currentRepeatOccurrence if starting a new data field with subfields
                // or if starting a new occurrence of a repeatable data field with subfields
                // This object tracks the current occurrence bbeing filled
                if (
                    isDataFieldWithSubfields &&
                    (!state.currentRepeatOccurrence || state.currentRepeatOccurrence.tag !== currentFieldTag)
                ) {
                    state.currentRepeatOccurrence = { tag: currentFieldTag, subfields: {} }
                } else if (!isDataFieldWithSubfields) {
                    // Clear currentRepeatOccurrence if not dealing with a data field with subfieds
                    delete state.currentRepeatOccurrence
                }

                // Determine which subfield to ask about (if dealing with a data field)
                let subfieldToAskCode: string | undefined
                let subfieldToAskDef: SubFieldDef | undefined

                if (isDataFieldWithSubfields) {
                    const dataFieldDef = currentFieldDef as DataField

                    // If we're already in the middle of this field, continue with the current subfield
                    if (state.askedField === currentFieldTag && state.askedSubfield) {
                        subfieldToAskCode = state.askedSubfield
                        subfieldToAskDef = dataFieldDef.subFieldDef.find((sf) => sf.code === subfieldToAskCode)
                    } else {
                        // If starting a new occurrence or working with this field for the first time
                        // Start with the first subfield in the definition
                        subfieldToAskCode = dataFieldDef.subFieldDef[0].code
                        subfieldToAskDef = dataFieldDef.subFieldDef[0]
                    }
                } else {
                    // For simple fields (without subfields), no subfield code to ask about
                    subfieldToAskCode = undefined
                }

                // Build the question with mandatory indication
                // This section constructs the user-friendly question that will be presented to the user
                // It incorporates field metadata, translations, and helpful tips
                const fieldTranslation = currentFieldDef.translations.find((t: Translation) => t.language === language)
                // Get the field name in the appropriate language, fall back to field tag if no translation
                const fieldName = fieldTranslation?.name || currentFieldTag
                // Extract tips for this field (helpful guidance for the user)
                const tips = fieldTranslation?.tips ?? []
                // Format tips as a readable string with emoji and bullet points if tips exist
                const tipsText = tips.length > 0 ? `\n\n💡 Dicas:\n${tips.map((tip) => `• ${tip}`).join("\n")}` : ""
                // Start building the question text with field name and tag
                let questionText = `Por favor, forneça: ${fieldName} [${currentFieldTag}]`
                // Variables to store subfield information for the response
                let subfieldNameForResponse: string | null = null
                let subfieldTips: string[] = []

                // Check if we're dealing with a subfield (data field with subfields)
                if (subfieldToAskCode) {
                    // Start with just the subfield code (e.g., $a)
                    let subfieldPart = `$${subfieldToAskCode}`

                    // Try to find a translation for the subfield
                    const subfieldTranslation = subfieldToAskDef?.translations?.find((t) => t.language === language)

                    // If we have a translated laber, use it in a user-friendly format
                    if (subfieldTranslation?.label) {
                        // Format as "Label ($a)" for better user experience
                        subfieldPart = `${subfieldTranslation.label} (${subfieldPart})`
                        subfieldNameForResponse = subfieldTranslation.label
                    } else {
                        // Fall back to using just the subfield code
                        subfieldNameForResponse = subfieldToAskCode
                    }

                    // Add mandatory/optional indication to the question
                    const mandatoryText = subfieldToAskDef?.mandatory ? " (obrigatório)" : " (opcional)"
                    questionText += ` - ${subfieldPart}${mandatoryText}`

                    // Get the tips for this specific subfield
                    subfieldTips = subfieldTranslation?.tips ?? []

                    // If the subfield is optional, add guidance about leaving it blank
                    if (!subfieldToAskDef?.mandatory) {
                        subfieldTips.unshift("Pode deixar em branco se não se aplicar")
                    }
                } else {
                    // This is a simple field (without subfields)
                    // Add mandatory/optional indication for the simple field
                    const mandatoryText = currentFieldDef.mandatory ? " (obrigatório)" : " (opcional)"
                    questionText += mandatoryText

                    // If the field is optional, add guidance about leaving it blank
                    if (!currentFieldDef.mandatory) {
                        tips.unshift("Pode deixar em branco se não se aplicar")
                    }
                }

                // Append the tips to the question text (if any tips exist)
                questionText += `.${tipsText}`

                // Log the field question detail for debugging
                console.log("=== ASKING USER FOR FIELD ===")
                console.log("Field:", currentFieldTag)
                console.log("Subfield:", subfieldToAskCode)
                console.log("Question:", questionText)

                // Return the response with the field question
                // This pauses the conversation until the user provides a response
                return NextResponse.json({
                    type: "field-question",     // Response type indicating we're asking for field input
                    field: currentFieldTag,     // The field tag being asked about
                    subfield: subfieldToAskCode,        // The subfield code (if applicable)
                    subfieldName: subfieldNameForResponse || null,      // User-friendly subfield name
                    question: questionText,     // The complete question text to display to the user
                    tips: tips,     // Field-level tips for guidance
                    subfieldTips: subfieldTips,     // Subfield-level tips (if applicable)
                    conversationState: {
                        ...state,       // Spread the current state
                        askedField: currentFieldTag,        // Track which field we're asking about
                        askedSubfield: subfieldToAskCode,       // Track whichh subfield we're asking about
                        repeatingField: state.repeatingField,       // Preserve the reapeatingField state
                        currentRepeatOccurrence: state.currentRepeatOccurrence,     // Preserve the current occurrence
                    },
                } as CatalogResponse)
            }

            // All fields filled - advance to confirmation
            // This point is reached when all fields have been processed
            console.log("=== ALL FIELDS FILLED - ADVANCING TO CONFIRMATION ===")
            state.step = "confirmation"     // Transition to the confirmation step

            // State before confirmation step
            // Detailed log of the complete state before moving to confirmation
            console.log("State before confirmation step:", JSON.stringify(state, null, 2))

            // Return the final response indicating all fields are complete
            // This uses new Response() instead of NextResponse.json() to have more control
            return new Response(
                // Stringify the response object
                JSON.stringify({
                    type: "record-complete",        // Response type indicating the record is complete
                    record: state.filledFields,     // All the field values that were coollected
                    conversationState: state,       // The current state to maintain context
                    template: {
                        id: state.currentTemplate.id,       // Template identifier
                        name: state.currentTemplate.name,       // Template name
                    },
                } as CatalogResponse),
                {
                    status: 200,        // HTTP 200 OK status
                    headers: {
                        "Content-Type": "application/json",     // Set the content type to JSON
                    },
                },
            )
        }

        // ================================
        // STEP 4: Confirmation and Storage
        // ================================
        // This is the final step where the completed record is converted to UNIMARC format
        // and stored in the database
        if (state.step === "confirmation") {
            console.log("=== INICIANDO CONFIRMAÇÃO E GRAVAÇÃO ===")

            // Safety check - ensure we have a template before proceeding
            if (!state.currentTemplate) {
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Template não encontrado para gravação.",
                    } as CatalogResponse,
                    { status: 400 },        // HTTP 400 Bad Request
                )
            }

            try {
                // Log filled fields before UNIMARC conversion and saving
                // This provides a complete view of all collected data before conversion
                console.log("Filled fields before UNIMARC conversion and saving:", JSON.stringify(state.filledFields, null, 2))

                // Convert fields to UNIMARC using OpenAI
                // This uses AI to transform the structured data into proper UNIMARC text format
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

                // Call OpenAI to perform the UNIMARC conversion
                const unimarcCompletion = await openai.chat.completions.create({
                    model: "gpt-4",     // Use GPT-4 for better accuracy with complex formatting tasks
                    messages: [
                        {
                            role: "system",
                            content:
                                "Você é um especialista em UNIMARC. Converta o JSON fornecido para o formato de texto UNIMARC EXATO, seguindo as regras estritas. Ignore valores inválidos como 'não' ou vazios.",
                        },
                        { role: "user", content: unimarcConversionPrompt },
                    ],
                    temperature: 0.1,       // Low temperature for deterministic, rule-following output
                    max_tokens: 1000,       // Sufficient tokens for potentially long UNIMARC records
                })

                // Extract the generated UNIMARC text
                const textUnimarc = unimarcCompletion.choices[0]?.message?.content?.trim() || ""
                console.log("Generated UNIMARC text:", textUnimarc)

                // Prepare data for persistence
                // This structures the data for storage in the database
                const fieldsToSave: Array<{
                    tag: string
                    value: string | null
                    subfields?: Prisma.JsonValue
                    fieldType: FieldType
                    fieldName: string | null
                    subfieldNames?: Prisma.JsonValue
                }> = Object.entries(state.filledFields)
                    .flatMap(([tag, value]) => {
                        // Use flatMap to handle arrays (repeatable fields)
                        let fieldDef: FieldDefinition | undefined

                        // Find the field definition in the template
                        if (state.currentTemplate) {
                            fieldDef = [...state.currentTemplate.controlFields, ...state.currentTemplate.dataFields].find(
                                (f) => f.tag === tag,
                            )
                        }

                        // Determine field type (DATA fields have subfields, CONTROL fields don't)
                        const fieldType = fieldDef && "subFieldDef" in fieldDef ? FieldType.DATA : FieldType.CONTROL

                        // Get the field name in the appropriate language, fall back to tag
                        const fieldName = fieldDef?.translations.find((t: Translation) => t.language === language)?.name || tag

                        if (Array.isArray(value)) {
                            // Handle  repeatable fields (complete occurrences or simple values)
                            return value
                                .map((item) => {
                                    let fieldValue: string | null = null
                                    let subfieldValues: Prisma.JsonValue | undefined
                                    let subfieldNames: Prisma.JsonValue | undefined

                                    if (fieldType === FieldType.DATA && typeof item === "object" && item !== null) {
                                        // Item is a subfields object for a data field
                                        const filteredSubfields: Record<string, any> = {}

                                        // Filter out invalid subfield values
                                        for (const [subcode, subvalue] of Object.entries(item)) {
                                            if (isValidFieldValue(subvalue)) {
                                                filteredSubfields[subcode] = subvalue
                                            }
                                        }
                                        subfieldValues = filteredSubfields as Prisma.JsonValue
                                        const dataFieldDef = fieldDef as DataField
                                        subfieldNames = {}

                                        // Create a mapping of subfield codes to their names
                                        dataFieldDef.subFieldDef.forEach((sf) => {
                                            const sfTranslation = sf.translations?.find((t) => t.language === language)
                                                ; (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code
                                        })
                                    } else {
                                        // Item is a simple value for a control/simple data field
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
                                // Filter  out empty fields (no value and no subfields)
                                .filter(
                                    (field) =>
                                        field.value !== null || (field.subfields && Object.keys(field.subfields as object).length > 0),
                                )
                        } else {
                            // Handle non-repeatable fields (current logic)
                            let fieldValue: string | null = null
                            let subfieldValues: Prisma.JsonValue | undefined
                            let subfieldNames: Prisma.JsonValue | undefined

                            if (fieldType === FieldType.DATA && typeof value === "object" && value !== null) {
                                const filteredSubfields: Record<string, any> = {}

                                // Process each subfield value
                                for (const [subcode, subvalue] of Object.entries(value)) {
                                    // Handle subfields that are arrays (repeatable)
                                    if (Array.isArray(subvalue)) {
                                        // Filter valid values from repeatable subfields
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

                                // Create subfield name mappings
                                dataFieldDef.subFieldDef.forEach((sf) => {
                                    const sfTranslation = sf.translations?.find((t) => t.language === language)
                                        ; (subfieldNames as Record<string, string>)[sf.code] = sfTranslation?.label || sf.code
                                })
                            } else {
                                // Simple field value
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
                    // Filter out completely emmpty fields
                    .filter(
                        (field) => field.value !== null || (field.subfields && Object.keys(field.subfields as object).length > 0),
                    )

                // Log fields prepared for saving (fieldToSave)
                console.log("Fields prepared for saving (fieldsToSave):", JSON.stringify(fieldsToSave, null, 2))

                // Persist to database
                console.log("Saving record to database...")

                // Call the database serice to save the complete record
                const recordId = await databaseService.saveRecord({
                    templateId: state.currentTemplate.id,
                    templateName: state.currentTemplate.name,
                    templateDesc: `Registo catalogado automaticamente - ${new Date().toLocaleDateString()}`,
                    filledFields: state.filledFields,       // The original filled data
                    template: state.currentTemplate,        // The template used for cataloging
                    textUnimarc,        // The generated UNIMARC text
                    fields: fieldsToSave.map((f) => ({
                        ...f,
                        value: f.value ?? null,     // Ensure null instead of undefined
                        fieldName: f.fieldName ?? null,
                        subfields: f.subfields ?? null,
                        subfieldNames: f.subfieldNames ?? null,
                    })),
                })
                console.log("Record saved with ID:", recordId)

                // Return success response with record information
                return NextResponse.json({
                    type: "record-saved",
                    message: `Registo gravado com sucesso! ID: ${recordId}. ${state.autoFilledCount || 0} campos preenchidos automaticamente.`,
                    record: state.filledFields,
                    recordId,
                    textUnimarc,
                    conversationState: {
                        ...state,
                        step: "completed",      // Mark the conversation as completed
                    },
                } as CatalogResponse)
            } catch (error) {
                // Handle any errors during saving process
                console.error("Erro ao gravar registo:", error)
                return NextResponse.json(
                    {
                        type: "error",
                        error: "Erro ao gravar registo na base de dados.",
                        details: error instanceof Error ? error.message : "Erro desconhecido",
                    } as CatalogResponse,
                    { status: 500 },        // HTTP  500 Internal Server Error
                )
            }
        }

        // Fallbabck for invalid state
        // This handles cases where the conversation reaches an unexpected step
        console.log("=== FALLBACK - INVALID STATE ===")
        console.log("Current step:", state.step)
        return NextResponse.json(
            {
                type: "error",
                error: "Estado inválido da conversação.",
            } as CatalogResponse,
            { status: 400 },        // HTTP 400 Bad Request
        )
    } catch (error: any) {
        // Global error handler for the entire API endpoint
        console.error("Erro na API:", error)
        return NextResponse.json(
            {
                type: "error",
                error: "Erro interno no servidor",
                details: error.message,
            } as CatalogResponse,
            { status: 500 },        // HTTP  500 Internal Server Error
        )
    }
}
