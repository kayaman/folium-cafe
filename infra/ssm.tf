# Created with throwaway placeholder values; the real secrets are written once
# out-of-band (see Phase 4) and ignored thereafter so they never enter state diffs.
resource "aws_ssm_parameter" "password" {
  name  = "/${var.name_prefix}/app_password"
  type  = "SecureString"
  value = "change-me-set-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}

resource "aws_ssm_parameter" "hmac_key" {
  name  = "/${var.name_prefix}/hmac_key"
  type  = "SecureString"
  value = "change-me-set-out-of-band"

  lifecycle {
    ignore_changes = [value]
  }
}

# Invite-only signup allowlist (JSON array of emails or "@domain" entries).
# Read at runtime by the pre-sign-up trigger; set out-of-band:
#   aws ssm put-parameter --name /folium-cafe/signup_allowlist \
#     --type SecureString --overwrite --value '["you@example.com"]'
resource "aws_ssm_parameter" "signup_allowlist" {
  name  = "/${var.name_prefix}/signup_allowlist"
  type  = "SecureString"
  value = "[]"

  lifecycle {
    ignore_changes = [value]
  }
}
