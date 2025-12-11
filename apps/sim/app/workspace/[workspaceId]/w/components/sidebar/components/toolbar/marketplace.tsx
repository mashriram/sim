'use client'

import { useMemo, useState } from 'react'
import { Search, Grid, List } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToolbarBlock } from './components/toolbar-block/toolbar-block'
import LoopToolbarItem from './components/toolbar-loop-block/toolbar-loop-block'
import ParallelToolbarItem from './components/toolbar-parallel-block/toolbar-parallel-block'
import { getAllBlocks } from '@/blocks'
import type { WorkspaceUserPermissions } from '@/hooks/use-user-permissions'
import { cn } from '@/lib/utils'
import type { BlockSubCategory } from '@/blocks/types'

interface MarketplaceProps {
  userPermissions: WorkspaceUserPermissions
}

const CATEGORIES: { id: string; label: string; subCategories: BlockSubCategory[] }[] = [
  { id: 'all', label: 'All', subCategories: [] },
  { id: 'core', label: 'Core', subCategories: ['Core', 'Utility'] },
  { id: 'ai', label: 'AI', subCategories: ['AI'] },
  { id: 'connectors', label: 'Connectors', subCategories: ['Social', 'Communication', 'Productivity', 'Finance', 'Development', 'Database'] },
]

export function Marketplace({ userPermissions }: MarketplaceProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [activeTab, setActiveTab] = useState('all')

  const { groupedBlocks } = useMemo(() => {
    const allBlocks = getAllBlocks()

    // Assign default subcategories if missing
    const blocksWithCategory = allBlocks.map(b => ({
       ...b,
       subCategory: b.subCategory || inferCategory(b)
    }));

    const filtered = blocksWithCategory.filter((block) => {
      if (block.type === 'starter' || block.hideFromToolbar) return false

      const matchesSearch = !searchQuery.trim() ||
        block.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        block.description.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      if (activeTab === 'all') return true;

      const categoryConfig = CATEGORIES.find(c => c.id === activeTab);
      if (!categoryConfig) return true;

      return categoryConfig.subCategories.includes(block.subCategory as BlockSubCategory);
    });

    // Sort by name
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    return { groupedBlocks: filtered }
  }, [searchQuery, activeTab])

  return (
    <div className='flex h-full flex-col bg-background'>
      <div className='flex-shrink-0 p-3 space-y-3'>
        <div className='flex h-9 items-center gap-2 rounded-[8px] border bg-background pr-2 pl-3 shadow-sm'>
          <Search className='h-4 w-4 text-muted-foreground' strokeWidth={2} />
          <Input
            placeholder='Search marketplace...'
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className='h-6 flex-1 border-0 bg-transparent px-0 text-sm leading-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0'
          />
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="w-full justify-start h-auto p-0 bg-transparent gap-2 overflow-x-auto no-scrollbar">
            {CATEGORIES.map(cat => (
              <TabsTrigger
                key={cat.id}
                value={cat.id}
                className="rounded-full border px-3 py-1 data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs"
              >
                {cat.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <ScrollArea className='flex-1 px-3 pb-3'>
        <div className='grid grid-cols-1 gap-2'>
           {/* Special Blocks (Loop/Parallel) - Show always or only in Core/All */}
           {(activeTab === 'all' || activeTab === 'core') && !searchQuery && (
             <>
               <LoopToolbarItem disabled={!userPermissions.canEdit} />
               <ParallelToolbarItem disabled={!userPermissions.canEdit} />
             </>
           )}

           {groupedBlocks.map(block => (
             <ToolbarBlock
               key={block.type}
               config={block}
               disabled={!userPermissions.canEdit}
             />
           ))}

           {groupedBlocks.length === 0 && (
             <div className="text-center py-8 text-muted-foreground text-sm">
               No blocks found.
             </div>
           )}
        </div>
      </ScrollArea>
    </div>
  )
}

function inferCategory(block: any): BlockSubCategory {
  // Simple heuristic based on type or name
  const name = block.name.toLowerCase();
  const type = block.type.toLowerCase();

  if (['openai', 'anthropic', 'mistral', 'huggingface', 'elevenlabs', 'midjourney', 'stability', 'thinking'].some(k => type.includes(k))) return 'AI';
  if (['slack', 'discord', 'whatsapp', 'telegram', 'email', 'gmail', 'outlook'].some(k => type.includes(k))) return 'Communication';
  if (['google_sheets', 'notion', 'airtable', 'linear', 'jira', 'trello'].some(k => type.includes(k))) return 'Productivity';
  if (['postgres', 'mysql', 'supabase', 'firebase', 'pinecone', 'qdrant'].some(k => type.includes(k))) return 'Database';
  if (['github', 'gitlab', 'docker'].some(k => type.includes(k))) return 'Development';
  if (['stripe', 'paypal'].some(k => type.includes(k))) return 'Finance';
  if (['webhook', 'schedule', 'api', 'function', 'router', 'condition', 'evaluator'].some(k => type.includes(k))) return 'Core';

  return 'Other';
}
