import type { ToolCallRecord } from '../types'

/**
 * Thumbnails a tool asked to show (image_search). These are data: URLs the main
 * process already fetched and downscaled — never remote URLs — so rendering one
 * makes no network request at all. Each thumbnail links to the page the image
 * came from.
 */
export function ToolImageGallery({ records }: { records: ToolCallRecord[] }): JSX.Element | null {
  const withImages = records.filter((r) => r.status === 'done' && r.images && r.images.length > 0)
  if (withImages.length === 0) return null
  return (
    <>
      {withImages.map((record) => {
        // v1.6: an image the Workbench produced (a matplotlib figure) has no
        // source page — it is shown larger, unlinked, and captioned as computed.
        const produced = record.name === 'run_python'
        return (
          <div key={`${record.id}-images`} className="mt-2">
            <div className={produced ? 'flex flex-wrap gap-2' : 'grid grid-cols-3 gap-2'}>
              {record.images!.map((img, i) =>
                produced || !img.pageUrl ? (
                  <img
                    key={i}
                    src={img.dataUrl}
                    alt={img.title}
                    title={img.title}
                    loading="lazy"
                    className="max-h-72 max-w-full rounded-xl border border-black/10 object-contain dark:border-white/15"
                  />
                ) : (
                  <a
                    key={i}
                    href={img.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    title={`${img.title}\n${img.pageUrl}`}
                    className="block overflow-hidden rounded-xl border border-black/10 transition-transform hover:scale-[1.02] dark:border-white/15"
                  >
                    <img src={img.dataUrl} alt={img.title} loading="lazy" className="h-24 w-full object-cover" />
                  </a>
                )
              )}
            </div>
            <div className="mt-1 text-[10px] text-ink-tertiary">
              {produced
                ? `📈 ${record.images!.length} figure(s) produced by the code that ran: ${record.images!.map((i) => i.title).join(', ')}`
                : `🖼️ ${record.images!.length} image(s) for “${String(record.args.query ?? '')}” — click a thumbnail to open its source page.`}
            </div>
          </div>
        )
      })}
    </>
  )
}
