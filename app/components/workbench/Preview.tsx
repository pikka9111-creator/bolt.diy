import { useStore } from '@nanostores/react';
import { SandpackProvider, SandpackPreview } from '@codesandbox/sandpack-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import type { ElementInfo } from './Inspector';
import { InspectorPanel } from './InspectorPanel';
import { ScreenshotSelector } from './ScreenshotSelector';
import { IconButton } from '~/components/ui/IconButton';
import { ExpoQrModal } from '~/components/workbench/ExpoQrModal';
import { expoUrlAtom } from '~/lib/stores/qrCodeStore';
import { workbenchStore } from '~/lib/stores/workbench';
import { extractRelativePath } from '~/utils/diff';

type ResizeSide = 'left' | 'right' | null;

interface PreviewProps {
  selectedElement?: ElementInfo | null;
  setSelectedElement?: (element: ElementInfo | null) => void;
}

interface WindowSize {
  name: string;
  width: number;
  height: number;
  icon: string;
  hasFrame?: boolean;
  frameType?: 'mobile' | 'tablet' | 'laptop' | 'desktop';
}

const WINDOW_SIZES: WindowSize[] = [
  { name: 'iPhone SE', width: 375, height: 667, icon: 'i-ph:device-mobile', hasFrame: true, frameType: 'mobile' },
  { name: 'iPhone 12/13', width: 390, height: 844, icon: 'i-ph:device-mobile', hasFrame: true, frameType: 'mobile' },
  {
    name: 'iPhone 12/13 Pro Max',
    width: 428,
    height: 926,
    icon: 'i-ph:device-mobile',
    hasFrame: true,
    frameType: 'mobile',
  },
  { name: 'iPad Mini', width: 768, height: 1024, icon: 'i-ph:device-tablet', hasFrame: true, frameType: 'tablet' },
  { name: 'iPad Air', width: 820, height: 1180, icon: 'i-ph:device-tablet', hasFrame: true, frameType: 'tablet' },
  { name: 'iPad Pro 11"', width: 834, height: 1194, icon: 'i-ph:device-tablet', hasFrame: true, frameType: 'tablet' },
  {
    name: 'iPad Pro 12.9"',
    width: 1024,
    height: 1366,
    icon: 'i-ph:device-tablet',
    hasFrame: true,
    frameType: 'tablet',
  },
  { name: 'Small Laptop', width: 1280, height: 800, icon: 'i-ph:laptop', hasFrame: true, frameType: 'laptop' },
  { name: 'Laptop', width: 1366, height: 768, icon: 'i-ph:laptop', hasFrame: true, frameType: 'laptop' },
  { name: 'Large Laptop', width: 1440, height: 900, icon: 'i-ph:laptop', hasFrame: true, frameType: 'laptop' },
  { name: 'Desktop', width: 1920, height: 1080, icon: 'i-ph:monitor', hasFrame: true, frameType: 'desktop' },
  { name: '4K Display', width: 3840, height: 2160, icon: 'i-ph:monitor', hasFrame: true, frameType: 'desktop' },
];

export const Preview = memo(({ selectedElement, setSelectedElement }: PreviewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const rawFiles = useStore(workbenchStore.files);
  const [displayPath, setDisplayPath] = useState('/');
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isInspectorMode, setIsInspectorMode] = useState(false);
  const [selectedInspectorElement, setSelectedInspectorElement] = useState<ElementInfo | null>(null);
  const [inspectorEdits, setInspectorEdits] = useState<Record<string, string>>({});
  const [inspectorUndoStack, setInspectorUndoStack] = useState<Array<{ property: string; value: string }>>([]);
  const inspectorOriginalRef = useRef<{ styles: Record<string, string>; textContent: string } | null>(null);
  const [isPreviewPaused, setIsPreviewPaused] = useState(false);
  const [isDeviceModeOn, setIsDeviceModeOn] = useState(false);
  const [widthPercent, setWidthPercent] = useState<number>(37.5);
  const [currentWidth, setCurrentWidth] = useState<number>(0);
  const [previewKey, setPreviewKey] = useState(0);

  const resizingState = useRef({
    isResizing: false,
    side: null as ResizeSide,
    startX: 0,
    startWidthPercent: 37.5,
    windowWidth: window.innerWidth,
    pointerId: null as number | null,
  });

  const SCALING_FACTOR = 1;

  const [isWindowSizeDropdownOpen, setIsWindowSizeDropdownOpen] = useState(false);
  const [selectedWindowSize, setSelectedWindowSize] = useState<WindowSize>(WINDOW_SIZES[0]);
  const [isLandscape, setIsLandscape] = useState(false);
  const [showDeviceFrame, setShowDeviceFrame] = useState(true);
  const [showDeviceFrameInPreview, setShowDeviceFrameInPreview] = useState(false);
  const expoUrl = useStore(expoUrlAtom);
  const [isExpoQrModalOpen, setIsExpoQrModalOpen] = useState(false);

  // Convert workbenchStore files to Sandpack file format
  const sandpackFiles = useMemo(() => {
    const files: Record<string, string> = {};

    for (const [filePath, dirent] of Object.entries(rawFiles)) {
      if (dirent?.type === 'file' && !dirent.isBinary) {
        let relative = extractRelativePath(filePath);

        if (!relative.startsWith('/')) {
          relative = '/' + relative;
        }

        files[relative] = dirent.content;
      }
    }

    if (Object.keys(files).length === 0) {
      files['/App.js'] = `export default function App() { return <h1>Hello Sandpack</h1>; }`;
      files['/index.js'] = `import React from "react"; import { createRoot } from "react-dom/client"; import App from "./App"; createRoot(document.getElementById("root")).render(<App />);`;
    }

    return files;
  }, [rawFiles]);

  // Determine Sandpack template from project files
  const template = useMemo(() => {
    const pkgContent = sandpackFiles['/package.json'];

    if (pkgContent) {
      try {
        const pkg = JSON.parse(pkgContent);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps.vue) {
          return Object.keys(sandpackFiles).some((f) => f.endsWith('.ts') || f.endsWith('.tsx')) ? 'vue-ts' : 'vue';
        }

        if (deps.react) {
          return Object.keys(sandpackFiles).some((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
            ? 'react-ts'
            : 'react';
        }
      } catch {}
    }

    const fileNames = Object.keys(sandpackFiles);

    if (fileNames.some((f) => f.endsWith('.vue'))) {
      return fileNames.some((f) => f.endsWith('.ts')) ? 'vue-ts' : 'vue';
    }

    if (fileNames.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'))) {
      return fileNames.some((f) => f.endsWith('.tsx') || f.endsWith('.ts')) ? 'react-ts' : 'react';
    }

    if (fileNames.some((f) => f.endsWith('.html'))) {
      return 'static';
    }

    return 'react';
  }, [sandpackFiles]);

  const reloadPreview = () => {
    setPreviewKey((prev) => prev + 1);
  };

  const toggleFullscreen = async () => {
    if (!isFullscreen && containerRef.current) {
      await containerRef.current.requestFullscreen();
    } else if (document.fullscreenElement) {
      await document.exitFullscreen();
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  const toggleDeviceMode = () => {
    setIsDeviceModeOn((prev) => !prev);
  };

  const startResizing = (e: React.PointerEvent, side: ResizeSide) => {
    if (!isDeviceModeOn) {
      return;
    }

    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ew-resize';

    resizingState.current = {
      isResizing: true,
      side,
      startX: e.clientX,
      startWidthPercent: widthPercent,
      windowWidth: window.innerWidth,
      pointerId: e.pointerId,
    };
  };

  const ResizeHandle = ({ side }: { side: ResizeSide }) => {
    if (!side) {
      return null;
    }

    return (
      <div
        className={`resize-handle-${side}`}
        onPointerDown={(e) => startResizing(e, side)}
        style={{
          position: 'absolute',
          top: 0,
          ...(side === 'left' ? { left: 0, marginLeft: '-7px' } : { right: 0, marginRight: '-7px' }),
          width: '15px',
          height: '100%',
          cursor: 'ew-resize',
          background: 'var(--bolt-elements-background-depth-4, rgba(0,0,0,.3))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          transition: 'background 0.2s',
          userSelect: 'none',
          touchAction: 'none',
          zIndex: 10,
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.background = 'var(--bolt-elements-background-depth-4, rgba(0,0,0,.3))')
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.background = 'var(--bolt-elements-background-depth-3, rgba(0,0,0,.15))')
        }
        title="Drag to resize width"
      >
        <GripIcon />
      </div>
    );
  };

  useEffect(() => {
    if (!isDeviceModeOn) {
      return;
    }

    const handlePointerMove = (e: PointerEvent) => {
      const state = resizingState.current;

      if (!state.isResizing || e.pointerId !== state.pointerId) {
        return;
      }

      const dx = e.clientX - state.startX;
      const dxPercent = (dx / state.windowWidth) * 100 * SCALING_FACTOR;

      let newWidthPercent = state.startWidthPercent;

      if (state.side === 'right') {
        newWidthPercent = state.startWidthPercent + dxPercent;
      } else if (state.side === 'left') {
        newWidthPercent = state.startWidthPercent - dxPercent;
      }

      newWidthPercent = Math.max(10, Math.min(newWidthPercent, 90));

      setWidthPercent(newWidthPercent);

      if (containerRef.current) {
        const containerWidth = containerRef.current.clientWidth;
        const newWidth = Math.round((containerWidth * newWidthPercent) / 100);
        setCurrentWidth(newWidth);
      }
    };

    const handlePointerUp = (e: PointerEvent) => {
      const state = resizingState.current;

      if (!state.isResizing || e.pointerId !== state.pointerId) {
        return;
      }

      const handles = document.querySelectorAll('.resize-handle-left, .resize-handle-right');

      handles.forEach((handle) => {
        if ((handle as HTMLElement).hasPointerCapture?.(e.pointerId)) {
          (handle as HTMLElement).releasePointerCapture(e.pointerId);
        }
      });

      resizingState.current = {
        ...resizingState.current,
        isResizing: false,
        side: null,
        pointerId: null,
      };

      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    document.addEventListener('pointermove', handlePointerMove, { passive: false });
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerUp);

    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [isDeviceModeOn, SCALING_FACTOR]);

  const GripIcon = () => (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100%',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          color: 'var(--bolt-elements-textSecondary, rgba(0,0,0,0.5))',
          fontSize: '10px',
          lineHeight: '5px',
          userSelect: 'none',
          marginLeft: '1px',
        }}
      >
        ••• •••
      </div>
    </div>
  );

  const getFramePadding = useCallback(() => {
    if (!selectedWindowSize) {
      return '40px 20px';
    }

    const isMobile = selectedWindowSize.frameType === 'mobile';

    if (isLandscape) {
      return isMobile ? '40px 60px' : '30px 50px';
    }

    return isMobile ? '40px 20px' : '50px 30px';
  }, [isLandscape, selectedWindowSize]);

  const getFrameColor = useCallback(() => {
    const isDarkMode =
      document.documentElement.classList.contains('dark') ||
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      window.matchMedia('(prefers-color-scheme: dark)').matches;

    return isDarkMode ? '#555' : '#111';
  }, []);

  const updateInspectorEdit = (property: string, value: string) => {
    if (!selectedInspectorElement) {
      return;
    }

    const originalValue =
      property === 'textContent'
        ? (inspectorOriginalRef.current?.textContent ?? '')
        : (inspectorOriginalRef.current?.styles[property] ?? '');

    const currentValue = inspectorEdits[property] ?? originalValue;
    const nextEdits = { ...inspectorEdits };

    if (value === originalValue) {
      setInspectorUndoStack((stack) => stack.filter((edit) => edit.property !== property));
      delete nextEdits[property];
    } else {
      setInspectorUndoStack((stack) => [...stack, { property, value: currentValue }]);
      nextEdits[property] = value;
    }

    setInspectorEdits(nextEdits);

    const getVisualEdits = (edits: Record<string, string>) =>
      Object.entries(edits).map(([prop, val]) => ({ property: prop, value: val }));

    if (property === 'textContent') {
      setSelectedInspectorElement((element) =>
        element ? { ...element, textContent: value, visualEdits: getVisualEdits(nextEdits) } : element,
      );
      setSelectedElement?.({ ...selectedInspectorElement, textContent: value, visualEdits: getVisualEdits(nextEdits) });
    } else {
      const updatedStyles = { ...selectedInspectorElement.styles, [property]: value };
      setSelectedInspectorElement((element) =>
        element ? { ...element, styles: updatedStyles, visualEdits: getVisualEdits(nextEdits) } : element,
      );
      setSelectedElement?.({
        ...selectedInspectorElement,
        styles: updatedStyles,
        visualEdits: getVisualEdits(nextEdits),
      });
    }
  };

  const undoInspectorEdit = () => {
    const lastEdit = inspectorUndoStack[inspectorUndoStack.length - 1];

    if (!lastEdit || !selectedInspectorElement) {
      return;
    }

    setInspectorUndoStack((stack) => stack.slice(0, -1));
  };

  const resetInspectorEdits = () => {
    if (!selectedInspectorElement || !inspectorOriginalRef.current) {
      return;
    }

    setInspectorEdits({});
    setInspectorUndoStack([]);

    const resetElement = {
      ...selectedInspectorElement,
      styles: inspectorOriginalRef.current.styles,
      textContent: inspectorOriginalRef.current.textContent,
      visualEdits: [],
    };
    setSelectedInspectorElement(resetElement);
    setSelectedElement?.(resetElement);
  };

  const closeInspectorPanel = () => {
    setSelectedInspectorElement(null);
    setSelectedElement?.(null);
    setInspectorEdits({});
    setInspectorUndoStack([]);
    inspectorOriginalRef.current = null;
  };

  const toggleInspectorMode = () => {
    setIsInspectorMode(!isInspectorMode);
  };

  return (
    <div ref={containerRef} className={`w-full h-full flex flex-col relative`}>
      <div className="bg-bolt-elements-background-depth-2 p-2 flex items-center gap-2">
        <div className="flex items-center gap-2">
          <IconButton icon="i-ph:arrow-clockwise" onClick={reloadPreview} title="Reload Preview" />
          <IconButton
            icon={isPreviewPaused ? 'i-ph:play' : 'i-ph:pause'}
            onClick={() => setIsPreviewPaused((prev) => !prev)}
            title={isPreviewPaused ? 'Resume Preview' : 'Pause Preview'}
          />
          <IconButton
            icon="i-ph:selection"
            onClick={() => setIsSelectionMode(!isSelectionMode)}
            className={isSelectionMode ? 'bg-bolt-elements-background-depth-3' : ''}
          />
        </div>

        <div className="flex-grow flex items-center gap-1 bg-bolt-elements-preview-addressBar-background border border-bolt-elements-borderColor text-bolt-elements-preview-addressBar-text rounded-full px-1 py-1 text-sm">
          <input
            title="URL Path"
            ref={inputRef}
            className="w-full bg-transparent outline-none px-2"
            type="text"
            value={displayPath}
            onChange={(event) => setDisplayPath(event.target.value)}
          />
        </div>

        <div className="flex items-center gap-2">
          <IconButton
            icon="i-ph:devices"
            onClick={toggleDeviceMode}
            title={isDeviceModeOn ? 'Switch to Responsive Mode' : 'Switch to Device Mode'}
          />

          {expoUrl && <IconButton icon="i-ph:qr-code" onClick={() => setIsExpoQrModalOpen(true)} title="Show QR" />}

          <ExpoQrModal open={isExpoQrModalOpen} onClose={() => setIsExpoQrModalOpen(false)} />

          {isDeviceModeOn && (
            <>
              <IconButton
                icon="i-ph:device-rotate"
                onClick={() => setIsLandscape(!isLandscape)}
                title={isLandscape ? 'Switch to Portrait' : 'Switch to Landscape'}
              />
              <IconButton
                icon={showDeviceFrameInPreview ? 'i-ph:device-mobile' : 'i-ph:device-mobile-slash'}
                onClick={() => setShowDeviceFrameInPreview(!showDeviceFrameInPreview)}
                title={showDeviceFrameInPreview ? 'Hide Device Frame' : 'Show Device Frame'}
              />
            </>
          )}
          <IconButton
            icon="i-ph:cursor-click"
            onClick={toggleInspectorMode}
            className={
              isInspectorMode ? 'bg-bolt-elements-background-depth-3 !text-bolt-elements-item-contentAccent' : ''
            }
            title={isInspectorMode ? 'Disable Element Inspector' : 'Enable Element Inspector'}
          />
          <IconButton
            icon={isFullscreen ? 'i-ph:arrows-in' : 'i-ph:arrows-out'}
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
          />
        </div>
      </div>

      <div className="flex-1 border-t border-bolt-elements-borderColor flex justify-center items-center overflow-auto">
        <div
          style={{
            width: isDeviceModeOn ? (showDeviceFrameInPreview ? '100%' : `${widthPercent}%`) : '100%',
            height: '100%',
            overflow: 'auto',
            background: 'var(--bolt-elements-background-depth-1)',
            position: 'relative',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          {isPreviewPaused ? (
            <div className="flex h-full w-full items-center justify-center text-sm text-bolt-elements-textSecondary">
              Preview paused. Click the play icon to resume.
            </div>
          ) : isDeviceModeOn && showDeviceFrameInPreview ? (
            <div
              className="device-wrapper"
              style={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                width: '100%',
                height: '100%',
                padding: '0',
                overflow: 'auto',
                transition: 'all 0.3s ease',
                position: 'relative',
              }}
            >
              <div
                className="device-frame-container"
                style={{
                  position: 'relative',
                  borderRadius: selectedWindowSize.frameType === 'mobile' ? '36px' : '20px',
                  background: getFrameColor(),
                  padding: getFramePadding(),
                  boxShadow: '0 10px 30px rgba(0,0,0,0.2)',
                  overflow: 'hidden',
                  transform: 'scale(1)',
                  transformOrigin: 'center center',
                  transition: 'all 0.3s ease',
                  margin: '40px',
                  width: isLandscape
                    ? `${selectedWindowSize.height + (selectedWindowSize.frameType === 'mobile' ? 120 : 60)}px`
                    : `${selectedWindowSize.width + (selectedWindowSize.frameType === 'mobile' ? 40 : 60)}px`,
                  height: isLandscape
                    ? `${selectedWindowSize.width + (selectedWindowSize.frameType === 'mobile' ? 80 : 60)}px`
                    : `${selectedWindowSize.height + (selectedWindowSize.frameType === 'mobile' ? 80 : 100)}px`,
                }}
              >
                <SandpackProvider key={previewKey} template={template} files={sandpackFiles}>
                  <SandpackPreview
                    showNavigator={false}
                    showRefreshButton={false}
                    style={{
                      border: 'none',
                      width: isLandscape ? `${selectedWindowSize.height}px` : `${selectedWindowSize.width}px`,
                      height: isLandscape ? `${selectedWindowSize.width}px` : `${selectedWindowSize.height}px`,
                      background: 'white',
                      display: 'block',
                    }}
                  />
                </SandpackProvider>
              </div>
            </div>
          ) : (
            <SandpackProvider key={previewKey} template={template} files={sandpackFiles}>
              <SandpackPreview
                showNavigator={false}
                showRefreshButton={false}
                style={{
                  border: 'none',
                  width: '100%',
                  height: '100%',
                  background: 'var(--bolt-elements-background-depth-1)',
                }}
              />
            </SandpackProvider>
          )}

          {isDeviceModeOn && !showDeviceFrameInPreview && (
            <>
              <div
                style={{
                  position: 'absolute',
                  top: '-25px',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  background: 'var(--bolt-elements-background-depth-3, rgba(0,0,0,0.7))',
                  color: 'var(--bolt-elements-textPrimary, white)',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  pointerEvents: 'none',
                  opacity: resizingState.current.isResizing ? 1 : 0,
                  transition: 'opacity 0.3s',
                }}
              >
                {currentWidth}px
              </div>

              <ResizeHandle side="left" />
              <ResizeHandle side="right" />
            </>
          )}
        </div>
      </div>
      <InspectorPanel
        selectedElement={selectedInspectorElement}
        onStyleChange={updateInspectorEdit}
        onTextChange={(value) => updateInspectorEdit('textContent', value)}
        onUndo={undoInspectorEdit}
        onReset={resetInspectorEdits}
        canUndo={inspectorUndoStack.length > 0}
        onClose={closeInspectorPanel}
      />
    </div>
  );
});
