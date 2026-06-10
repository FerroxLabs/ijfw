# PSScriptAnalyzer settings for IJFW.
#
# The only PowerShell in this repo is installer/src/install.ps1 -- a one-shot,
# interactive bootstrap installer fetched-and-run on Windows. Several default
# PSScriptAnalyzer rules are written for reusable modules/cmdlets and do not fit
# a user-facing installer; those are excluded below with rationale. Real
# correctness rules (parse errors, empty catch blocks, etc.) stay ON.
@{
    Severity = @('Error', 'Warning')
    ExcludeRules = @(
        # Installers print colored, human-facing progress to the console. Write-Host
        # is the correct tool for that; Write-Output/Information would pollute the
        # pipeline or hide the UX. Standard exclusion for bootstrap scripts.
        'PSAvoidUsingWriteHost',

        # Internal helper functions (Provision-Plugin, Remove-StalePosixLaunchers).
        # Approved-verb / singular-noun conventions matter for shipped modules a
        # user discovers via Get-Command; they are cosmetic for private installer
        # helpers, and renaming risks breaking call sites.
        'PSUseApprovedVerbs',
        'PSUseSingularNouns',

        # ShouldProcess (-WhatIf/-Confirm) is for reusable state-changing cmdlets.
        # This is a single-shot installer the user explicitly invoked; -WhatIf
        # plumbing across private helpers adds no value.
        'PSUseShouldProcessForStateChangingFunctions',

        # The script is fetched to a file and executed; PowerShell reads it fine
        # without a BOM. Adding a BOM risks the piped install path. Non-issue here.
        'PSUseBOMForUnicodeEncodedFile',

        # False positive: $Dir and $Yes ARE used (param-default expansion at the
        # top of the script and the IJFW_NONINTERACTIVE branch). PSSA's data-flow
        # does not track them through those paths.
        'PSReviewUnusedParameter'
    )
}
