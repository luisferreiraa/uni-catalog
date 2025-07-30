import type { FieldType, Prisma } from "@prisma/client"

export interface Translation {
    id: string
    language: string
    name: string // Nome do campo principal (ControlFieldTranslation, DataFieldTranslation)
    tips?: string[]
    ind1Name?: string // Para DataFieldTranslation
    ind1Tips?: string[] // Para DataFieldTranslation
    ind2Name?: string // Para DataFieldTranslation
    ind2Tips?: string[] // Para DataFieldTranslation
    fieldId?: string // Para ControlFieldTranslation, DataFieldTranslation
}

// Nova interface para as traduções dos subcampos
export interface SubfieldDefinitionTranslation {
    id: string
    language: string
    label: string // O nome legível do subcampo está aqui
    tips?: string[]
    subfieldId: string
}

export interface ControlField {
    id: string
    tag: string
    repeatable: boolean
    mandatory: boolean
    translations: Translation[] // Estas são as traduções do campo de controlo
    createdAt: string
}

export interface SubFieldDef {
    id: string
    code: string
    repeatable: boolean
    mandatory: boolean
    translations?: SubfieldDefinitionTranslation[] // <--- ADICIONADO: Array de traduções para o subcampo
    dataFieldId: string
    createdAt: string
}

export interface DataField {
    id: string
    tag: string
    repeatable: boolean
    mandatory: boolean
    translations: Translation[] // Estas são as traduções do campo de dados
    subFieldDef: SubFieldDef[] // Agora SubFieldDef inclui 'translations'
    createdAt: string
}

export interface Template {
    id: string
    name: string
    description?: string
    controlFields: ControlField[]
    dataFields: DataField[]
    createdAt: string
}

export interface TemplatesResponse {
    templates: Template[]
}

// Export FieldDefinition
export type FieldDefinition = ControlField | DataField

export type ConversationStep =
    | "template-selection"
    | "bulk-auto-fill"
    | "bulk-field-filling"
    | "field-filling"
    | "confirmation"
    | "completed"
    | "review-fields"

export interface ConversationState {
    step: ConversationStep
    currentTemplate?: Template
    filledFields: Record<string, any | any[]> // Can be a single value or an array of values/objects
    remainingFields: string[]
    askedField?: string
    askedSubfield?: string
    autoFilledCount?: number
    repeatingField?: boolean
    repeatConfirmation?: {
        field: string
        subfield?: string
    }
    currentRepeatOccurrence?: { tag: string; subfields: Record<string, any | any[]> } // MODIFICADO: subfields pode ser array
}

export interface CatalogRequest {
    description: string
    language?: string
    conversationState?: ConversationState
    userResponse?: string
    fieldToEdit?: string
}

export interface CatalogResponse {
    type:
    | "template-selected"
    | "bulk-auto-filled"
    | "field-question"
    | "field-auto-filled"
    | "record-complete"
    | "record-saved"
    | "template-not-found"
    | "error"
    | "repeat-confirmation"
    | "review-fields-display"
    conversationState?: ConversationState
    template?: { id: string; name: string; description?: string }
    field?: string
    subfield?: string
    question?: string
    value?: string
    record?: Record<string, any>
    recordId?: string
    validation?: string
    message?: string
    error?: string
    details?: string
    options?: Array<{ name: string; id: string }>
    tips?: string[]
    subfieldTips?: string[]
    textUnimarc?: string
    filledFields?: Record<string, any>
}

export type RecordField = {
    tag: string
    value: string | null
    subfields: Prisma.JsonValue | null
    fieldType: FieldType
    fieldName: string | null
    subfieldNames: Prisma.JsonValue | null
}

export type SaveRecordPayload = {
    templateId: string
    templateName: string
    templateDesc: string
    filledFields: Record<string, any>
    template: Template
    textUnimarc: string
    fields: RecordField[]
}
