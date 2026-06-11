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
