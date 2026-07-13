{{- define "platform.name" -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "platform.labels" -}}
app.kubernetes.io/part-of: agentic-platform
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{/* image reference with the optional private-registry prefix (AIRGAP.md) */}}
{{- define "platform.image" -}}
{{ .registry }}{{ .name }}:{{ .tag }}
{{- end -}}

{{/* optional env var from a secretKeyRef; renders nothing when name is empty */}}
{{- define "platform.secretEnv" -}}
{{- if .ref.name }}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .ref.name }}
      key: {{ .ref.key }}
{{- end }}
{{- end -}}

{{/* env vars shared by worker and console */}}
{{- define "platform.commonEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.externalPostgres.urlSecretName }}
      key: {{ .Values.externalPostgres.urlSecretKey }}
- name: TEMPORAL_ADDRESS
  value: {{ .Values.temporal.address | quote }}
- name: TEMPORAL_NAMESPACE
  value: {{ .Values.temporal.namespace | quote }}
- name: PLATFORM_ENV
  value: {{ .Values.platformEnv | quote }}
- name: LIMITS_CONFIG
  value: /etc/platform/limits.config.json
{{- if .Values.configs.tenants }}
- name: TENANTS_CONFIG
  value: /etc/platform/tenants.config.json
{{- end }}
{{- include "platform.secretEnv" (dict "env" "PLATFORM_DATA_KEY" "ref" .Values.secrets.platformDataKey) }}
{{- range .Values.secrets.extra }}
- name: {{ .env }}
  valueFrom:
    secretKeyRef:
      name: {{ .name }}
      key: {{ .key }}
{{- end }}
{{- end -}}
