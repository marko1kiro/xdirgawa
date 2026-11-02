import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@workspace/ui/components/sheet"
import { Textarea } from "@workspace/ui/components/textarea"
import { ImageIcon, Loader2Icon } from "lucide-react"
import { toast } from "sonner"
import { serverGenerateImage } from "@/lib/wa-server"

/**
 * Text-to-image, review-only. The generated image lands in the Media
 * Gallery as a normal asset (via onGenerated -> createMediaAsset, the
 * same path as Upload). Nothing is sent to WhatsApp from here: sending
 * happens only when the user later picks the asset in a composer,
 * template or broadcast.
 */
export function GenerateImageButton({
  onGenerated,
}: {
  onGenerated: (asset: {
    mediaKey: string
    mediaMime: string
    mediaType: "image" | "video" | "audio" | "document"
    fileName: string
    fileSizeBytes: number
  }) => void
}) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState("")
  const [generating, setGenerating] = useState(false)

  async function handleGenerate() {
    const clean = prompt.trim()
    if (!clean) return
    setGenerating(true)
    try {
      const res = await serverGenerateImage({ data: { prompt: clean } })
      onGenerated({
        mediaKey: res.mediaKey,
        mediaMime: res.mediaMime,
        mediaType: res.mediaType,
        fileName: "generated-image",
        fileSizeBytes: res.fileSizeBytes,
      })
      toast.success("Image generated — saved to the gallery")
      setPrompt("")
      setOpen(false)
    } catch (err: any) {
      toast.error(err?.message ?? "Image generation failed.")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button variant="outline">
            <ImageIcon />
            Generate image
          </Button>
        }
      />
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Generate image</SheetTitle>
          <SheetDescription>
            Describe the image. It is saved to the Media Gallery for review —
            nothing is sent to WhatsApp until you pick it yourself.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-2 py-4">
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A simple red apple on a plain white background, product photo"
            rows={5}
            maxLength={1000}
          />
          <p className="text-xs text-muted-foreground">
            {prompt.trim().length} / 1000 characters. Text-to-image only.
          </p>
        </div>
        <SheetFooter>
          <Button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
          >
            {generating ? (
              <>
                <Loader2Icon className="animate-spin" />
                Generating…
              </>
            ) : (
              "Generate"
            )}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
