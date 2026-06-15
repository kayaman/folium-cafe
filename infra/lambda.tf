data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${path.module}/../backend"
  output_path = "${path.module}/build/function.zip"
  excludes    = ["test", "function.zip"]
}

resource "aws_iam_role" "lambda" {
  name = "${var.name_prefix}-lambda"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = "${var.name_prefix}-lambda-policy"
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:Query", "dynamodb:PutItem", "dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.books.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.pdfs.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = [aws_ssm_parameter.password.arn, aws_ssm_parameter.hmac_key.arn]
      },
      {
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:*::foundation-model/anthropic.*",
          "arn:aws:bedrock:us-east-1:${data.aws_caller_identity.current.account_id}:inference-profile/*",
        ]
      }
    ]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${var.name_prefix}-api"
  retention_in_days = 14
}

# Shared secret CloudFront injects as a custom origin header; the handler rejects
# any request that doesn't carry it, so the public Function URL can't be abused
# directly (CloudFront OAC SigV4 can't sign browser POST/PUT bodies, so AWS_IAM
# auth on the URL is unusable for this app — see docs/superpowers/specs).
resource "random_password" "origin_secret" {
  length  = 48
  special = false
}

resource "aws_lambda_function" "api" {
  function_name    = "${var.name_prefix}-api"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "src/handler.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 29
  memory_size      = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.books.name
      PDF_BUCKET       = aws_s3_bucket.pdfs.bucket
      PASSWORD_PARAM   = aws_ssm_parameter.password.name
      HMAC_PARAM       = aws_ssm_parameter.hmac_key.name
      ORIGIN_SECRET    = random_password.origin_secret.result
      BEDROCK_MODEL_ID = var.bedrock_model_id
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "NONE"
}

# With AuthType=NONE the URL is publicly invocable; access is gated by the
# origin-secret header validated in the Lambda handler. Function URLs created
# from Oct 2025 onward require BOTH InvokeFunctionUrl and InvokeFunction.
resource "aws_lambda_permission" "public_url" {
  statement_id           = "AllowPublicFunctionUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

# Companion to the InvokeFunctionUrl grant (required for Oct-2025+ function URLs).
# lambda:InvokeFunction does not accept the FunctionUrlAuthType condition. Direct
# API invokers still can't do anything useful: the handler rejects any request
# lacking the origin secret, which only CloudFront supplies.
resource "aws_lambda_permission" "public_invoke" {
  statement_id  = "AllowPublicFunctionInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "*"
}
