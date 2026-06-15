# SES email identity for Cognito OTP mail. The folium.cafe hosted zone is NOT
# managed by Terraform (created out-of-band) — we reference it read-only via the
# existing data.aws_route53_zone.primary and only ADD records to it.
# NOTE: the AWS account's SES must be OUT of the sandbox for open/invite signups
# to email arbitrary recipients; otherwise only verified addresses receive mail.
resource "aws_ses_domain_identity" "folium" {
  domain = var.domain_name
}

resource "aws_route53_record" "ses_verification" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_amazonses.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = [aws_ses_domain_identity.folium.verification_token]
}

resource "aws_ses_domain_dkim" "folium" {
  domain = aws_ses_domain_identity.folium.domain
}

resource "aws_route53_record" "ses_dkim" {
  count   = 3
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "${aws_ses_domain_dkim.folium.dkim_tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_ses_domain_dkim.folium.dkim_tokens[count.index]}.dkim.amazonses.com"]
}

# Custom MAIL FROM so SPF aligns with the From domain (DMARC).
resource "aws_ses_domain_mail_from" "folium" {
  domain           = aws_ses_domain_identity.folium.domain
  mail_from_domain = "mail.${var.domain_name}"
}

resource "aws_route53_record" "mail_from_mx" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = aws_ses_domain_mail_from.folium.mail_from_domain
  type    = "MX"
  ttl     = 600
  records = ["10 feedback-smtp.us-east-1.amazonses.com"]
}

resource "aws_route53_record" "mail_from_spf" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = aws_ses_domain_mail_from.folium.mail_from_domain
  type    = "TXT"
  ttl     = 600
  records = ["v=spf1 include:amazonses.com ~all"]
}

resource "aws_route53_record" "dmarc" {
  zone_id = data.aws_route53_zone.primary.zone_id
  name    = "_dmarc.${var.domain_name}"
  type    = "TXT"
  ttl     = 600
  records = ["v=DMARC1; p=none;"]
}

# Cognito (DEVELOPER email sending) needs explicit permission on the identity.
resource "aws_ses_identity_policy" "cognito_send" {
  identity = aws_ses_domain_identity.folium.arn
  name     = "${var.name_prefix}-cognito-send"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = ["cognito-idp.amazonaws.com", "email.cognito-idp.amazonaws.com"] }
      Action    = ["ses:SendEmail", "ses:SendRawEmail"]
      Resource  = aws_ses_domain_identity.folium.arn
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}
