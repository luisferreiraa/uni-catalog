"use client"

import type React from "react"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import type { CatalogResponse } from "@/app/types/unimarc"

interface QuestionDisplayProps {
    response: CatalogResponse
}

export default function QuestionDisplay({ response }: QuestionDisplayProps) {
    if (response.type !== "field-question" || !response.question) {
        return null
    }

    const { field, subfield, subfieldName, tips, subfieldTips, question } = response as CatalogResponse & {
        type: "field-question"
        field: string
        question: string
        subfield?: string
        subfieldName?: string | null
        tips?: string[]
        subfieldTips?: string[]
    }

    return (
        <TooltipProvider>
            <div className="w-full max-w-3xl mx-auto p-4 text-gray-800">
                <div className="mb-4">
                    <p className="text-sm text-gray-500">Por favor, forneça:</p>
                    <h2 className="text-2xl font-semibold flex items-center mt-1">
                        {question.split("[")[0].replace("Por favor, forneça: ", "").trim()}
                        <Badge variant="secondary" className="ml-2 bg-gray-200 text-gray-700">
                            [{field}]
                        </Badge>

                        {tips && tips.length > 0 && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button className="ml-2 text-gray-500 hover:text-gray-700">
                                        <LightbulbIcon className="h-5 w-5" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs bg-gray-100 text-gray-800 border border-gray-300 rounded-md p-3 shadow">
                                    <ul className="list-disc list-inside space-y-1 text-sm">
                                        {tips.map((tip, index) => (
                                            <li key={index}>{tip}</li>
                                        ))}
                                    </ul>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </h2>
                </div>

                {subfield && (
                    <div className="mb-4 text-sm text-gray-600 flex items-center gap-2">
                        <span className="font-medium">Subcampo:</span>
                        <Badge variant="outline" className="bg-gray-100 text-gray-800 border-gray-300">
                            {subfieldName || subfield} (${subfield})
                        </Badge>

                        {subfieldTips && subfieldTips.length > 0 && (
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <button className="text-gray-500 hover:text-gray-700">
                                        <LightbulbIcon className="h-4 w-4" />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs bg-gray-100 text-gray-800 border border-gray-300 rounded-md p-3 shadow">
                                    <ul className="list-disc list-inside space-y-1 text-sm">
                                        {subfieldTips.map((tip, index) => (
                                            <li key={index}>{tip}</li>
                                        ))}
                                    </ul>
                                </TooltipContent>
                            </Tooltip>
                        )}
                    </div>
                )}
            </div>
        </TooltipProvider>
    )
}

function LightbulbIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg
            {...props}
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 3c0 1.3.5 2.6 1.5 3.5.8.7 1.3 1.5 1.5 2.5" />
            <path d="M9 18h6" />
            <path d="M10 22v-2c0-1.1.9-2 2-2s2 .9 2 2v2" />
        </svg>
    )
}
