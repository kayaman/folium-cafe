# The GitHub Actions OIDC provider already exists in this account (shared across
# workloads), so we reference it instead of creating/owning it here.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "ci" {
  name = "${var.name_prefix}-ci"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })
}

# Scoped to this app's resources plus the Terraform state backend. Broad-ish on
# purpose so `terraform apply` from CI can manage the whole stack; tighten later.
resource "aws_iam_role_policy" "ci" {
  name = "${var.name_prefix}-ci-policy"
  role = aws_iam_role.ci.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "TerraformState"
        Effect = "Allow"
        Action = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"]
        Resource = [
          "arn:aws:s3:::folio-tfstate-${data.aws_caller_identity.current.account_id}",
          "arn:aws:s3:::folio-tfstate-${data.aws_caller_identity.current.account_id}/*"
        ]
      },
      {
        Sid      = "TerraformLock"
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = "arn:aws:dynamodb:us-east-1:${data.aws_caller_identity.current.account_id}:table/folio-tflock"
      },
      {
        Sid    = "DeployArtifacts"
        Effect = "Allow"
        Action = [
          "s3:PutObject", "s3:GetObject", "s3:DeleteObject", "s3:ListBucket",
          "lambda:UpdateFunctionCode", "lambda:GetFunction",
          "cloudfront:CreateInvalidation"
        ]
        Resource = "*"
      },
      {
        Sid    = "ManageStack"
        Effect = "Allow"
        Action = [
          "cloudfront:*", "s3:*", "lambda:*", "dynamodb:*", "iam:*",
          "acm:*", "route53:*", "ssm:*", "logs:*"
        ]
        Resource = "*"
      }
    ]
  })
}
