"use client"

import Link from "next/link"

export function Navigation() {

    return (
        <nav className="bg-black border-b border-white/10 shadow-sm [font-family:var(--font-poppins)] sticky top-0 z-50">
            <div className="container mx-auto px-4">
                <div className="flex items-center justify-between h-16">
                    {/* Branding */}
                    <div className="flex items-center space-x-4">
                        <Link
                            href={"/admin"}
                            className="font-bold text-xl text-[#66b497] hover:text-[#88d4bb] transition-colors"
                        >
                            BiblioGest
                        </Link>
                    </div>
                </div>
            </div>
        </nav>
    )

}