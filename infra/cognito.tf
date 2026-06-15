resource "aws_cognito_user_pool" "users" {
  name                = "${var.name_prefix}-users"
  user_pool_tier      = "LITE" # OTP verification is in Lite; Essentials is ~2.7x.
  deletion_protection = "ACTIVE"

  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]

  username_configuration {
    case_sensitive = false
  }

  password_policy {
    minimum_length    = 12
    require_lowercase = false
    require_numbers   = false
    require_symbols   = false
    require_uppercase = false
  }

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
    string_attribute_constraints {
      min_length = 3
      max_length = 254
    }
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    email_subject        = "Your Folium verification code"
    email_message        = "Welcome to the reading room. Your verification code is {####}."
  }

  email_configuration {
    email_sending_account = "DEVELOPER"
    source_arn            = aws_ses_domain_identity.folium.arn
    from_email_address    = "Folium <no-reply@${var.domain_name}>"
  }

  lambda_config {
    pre_sign_up = aws_lambda_function.presignup.arn
  }
}

resource "aws_cognito_user_pool_client" "bff" {
  name            = "${var.name_prefix}-bff"
  user_pool_id    = aws_cognito_user_pool.users.id
  generate_secret = false

  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  access_token_validity  = 30
  id_token_validity      = 30
  refresh_token_validity = 90
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

# Pre-sign-up trigger: same deployment artifact as the API function, different
# handler entrypoint. Enforces the handle policy + the invite-only allowlist.
resource "aws_lambda_function" "presignup" {
  function_name    = "${var.name_prefix}-presignup"
  role             = aws_iam_role.lambda.arn
  runtime          = "nodejs20.x"
  handler          = "src/presignup.handler"
  filename         = data.archive_file.lambda.output_path
  source_code_hash = data.archive_file.lambda.output_base64sha256
  timeout          = 5
  memory_size      = 128

  environment {
    variables = {
      ALLOWLIST_PARAM = aws_ssm_parameter.signup_allowlist.name
    }
  }
}

resource "aws_lambda_permission" "cognito_presignup" {
  statement_id  = "AllowCognitoInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.presignup.function_name
  principal     = "cognito-idp.amazonaws.com"
  source_arn    = aws_cognito_user_pool.users.arn
}

output "user_pool_id" {
  value = aws_cognito_user_pool.users.id
}

output "user_pool_client_id" {
  value = aws_cognito_user_pool_client.bff.id
}
