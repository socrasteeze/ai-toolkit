import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import Sidebar from '@/components/Sidebar';
import { ThemeProvider } from '@/components/ThemeProvider';
import ConfirmModal from '@/components/ConfirmModal';
import { Suspense } from 'react';
import AuthWrapper from '@/components/AuthWrapper';
import DocModal from '@/components/DocModal';
import os from 'os';
import { CaptionDatasetModal } from '@/components/CaptionDatasetModal';
import MergeLoRAsModal from '@/components/MergeLoRAsModal';
import SafetensorsInfoModal from '@/components/SafetensorsInfoModal';
import UpsamplePromptsModal from '@/components/UpsamplePromptsModal';
import PromptBoxEditorModal from '@/components/PromptBoxEditorModal';

export const dynamic = 'force-dynamic';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Ostris - AI Toolkit',
  description: 'A toolkit for building AI things.',
  appleWebApp: { capable: true, title: 'AI-Toolkit', statusBarStyle: 'black-translucent' },
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Check if the AI_TOOLKIT_AUTH environment variable is set
  const authRequired = process.env.AI_TOOLKIT_AUTH ? true : false;

  const platform = os.platform();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                var theme = localStorage.getItem('theme') || 'dark';
                if (theme === 'dark') document.documentElement.classList.add('dark');
              })();
            `,
          }}
        />
      </head>
      <body className={inter.className}>
        <script dangerouslySetInnerHTML={{ __html: `window.server_platform = "${platform}";` }} />
        <ThemeProvider>
          <AuthWrapper authRequired={authRequired}>
            <div className="app-shell flex h-screen bg-gray-950">
              <Sidebar />
              <main className="flex-1 min-w-0 overflow-auto bg-gray-950 text-gray-100 relative">
                <div className="app-page-area">
                  <Suspense>{children}</Suspense>
                </div>
              </main>
            </div>
          </AuthWrapper>
        </ThemeProvider>
        <ConfirmModal />
        <DocModal />
        <CaptionDatasetModal />
        <MergeLoRAsModal />
        <SafetensorsInfoModal />
        <UpsamplePromptsModal />
        <PromptBoxEditorModal />
      </body>
    </html>
  );
}
