import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import ImageIcon from "@mui/icons-material/Image";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import SaveIcon from "@mui/icons-material/Save";

import { authFetch } from "./app/auth";
import { useBranding } from "./app/branding";
import { NotifyFn } from "./app/notify";
import { strings } from "./app/strings";
import { errorMessage } from "./app/utils";

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** 设置页的「品牌自定义」卡片：界面名称 + Logo 图标，保存到 /api/branding */
export function BrandingCard({ onNotify }: { onNotify: NotifyFn }) {
  const brand = useBranding();
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [clearLogo, setClearLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 服务端配置到达后同步名称（不覆盖用户正在输入的内容：只在 info 变化时同步）
  useEffect(() => {
    if (brand.info) setName(brand.info.name ?? "");
  }, [brand.info]);

  // 预览地址：新选的文件优先，其次已保存的自定义 logo，最后默认 favicon
  const shownLogo = previewUrl ?? brand.logoSrc ?? "/favicon.png";

  const pickFile = (picked: File | null) => {
    if (!picked) return;
    if (picked.size > LOGO_MAX_BYTES) {
      onNotify(strings.brandingLogoHint, "error");
      return;
    }
    setFile(picked);
    setClearLogo(false);
    const url = URL.createObjectURL(picked);
    setPreviewUrl(url);
  };

  const save = async () => {
    const form = new FormData();
    form.append("name", name);
    if (file) form.append("logo", file);
    if (clearLogo) form.append("clearLogo", "1");
    setSaving(true);
    try {
      const response = await authFetch("/api/branding", { method: "PUT", body: form });
      if (!response.ok) throw new Error(await response.text());
      onNotify(strings.brandingSaved, "success");
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setClearLogo(false);
      brand.reload();
    } catch (error) {
      onNotify(errorMessage(error) || strings.brandingSaveFailed, "error");
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setSaving(true);
    try {
      const response = await authFetch("/api/branding", { method: "DELETE" });
      if (!response.ok) throw new Error(await response.text());
      onNotify(strings.brandingResetDone, "success");
      setName("");
      setFile(null);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setPreviewUrl(null);
      setClearLogo(false);
      brand.reload();
    } catch (error) {
      onNotify(errorMessage(error) || strings.brandingResetFailed, "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box
      sx={{
        px: 1.5,
        py: 1.5,
        borderRadius: 2,
        border: "1px solid",
        borderColor: "divider",
        backgroundColor: "background.paper",
      }}
    >
      <Typography sx={{ fontWeight: 700 }}>{strings.brandingTitle}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {strings.brandingHint}
      </Typography>
      <Stack direction="row" spacing={2} sx={{ mt: 1.5, alignItems: "center" }}>
        <Box
          component="img"
          src={shownLogo}
          alt=""
          sx={{
            width: 56,
            height: 56,
            borderRadius: 1.5,
            border: "1px solid",
            borderColor: "divider",
            objectFit: "contain",
            backgroundColor: "background.default",
            flexShrink: 0,
          }}
        />
        <Box sx={{ minWidth: 0 }}>
          <Button
            size="small"
            variant="outlined"
            startIcon={<ImageIcon />}
            onClick={() => fileInputRef.current?.click()}
          >
            {strings.brandingLogoChoose}
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.5 }}>
            {strings.brandingLogoHint}
          </Typography>
        </Box>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/x-icon"
          hidden
          onChange={(event) => {
            pickFile(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </Stack>
      <TextField
        fullWidth
        size="small"
        sx={{ mt: 1.5 }}
        label={strings.brandingNameLabel}
        placeholder={strings.brandingNamePlaceholder}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: "wrap" }}>
        <Button
          variant="contained"
          size="small"
          startIcon={saving ? <CircularProgress size={14} color="inherit" /> : <SaveIcon />}
          disabled={saving}
          onClick={save}
        >
          {strings.brandingSave}
        </Button>
        {brand.info?.hasCustomLogo && !file && (
          <Button
            size="small"
            disabled={saving}
            onClick={() => {
              setClearLogo(true);
              setPreviewUrl(null);
            }}
          >
            {strings.brandingClearLogo}
          </Button>
        )}
        <Button
          size="small"
          color="inherit"
          startIcon={<RestartAltIcon />}
          disabled={saving || (!brand.isCustom && !file && name === (brand.info?.name ?? ""))}
          onClick={reset}
        >
          {strings.brandingReset}
        </Button>
      </Stack>
    </Box>
  );
}
